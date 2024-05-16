import { parse } from "csv-parse/sync";
import fs from "fs-extra";
import * as turf from "@turf/turf";

const ROUTES_GEOJSON_FILE = "public/routes.geojson";
const STATS_FILE = "public/stats.json";

const FLAG_COLORS = {
  red: "#f00",
  yellow: "#ff0",
  green: "#0f0",
};

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAndParseCsv(filePath) {
  const citiesCsv = await fs.readFile(filePath, "utf8");
  const cities = parse(citiesCsv, { columns: true, skip_empty_lines: true });
  return cities.filter((city) => city.uf_code === "RS");
}

function convertToGeoJson(cities) {
  return {
    type: "FeatureCollection",
    features: cities.map((city) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [parseFloat(city.lon), parseFloat(city.lat)],
      },
      properties: {
        name: city.name,
        state: city.uf_code,
        slug_name: city.slug_name,
      },
    })),
  };
}

async function saveGeoJsonToFile(filePath, data) {
  await fs.ensureDir("routes");
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const cities = await readAndParseCsv("municipios.csv");
  const citiesGeoJson = convertToGeoJson(cities);

  // Open stats file
  let stats = {};
  try {
    stats = await fs.readJson(STATS_FILE);
  } catch (error) {
    await fs.writeJson(STATS_FILE, stats);
  }

  if (stats.lastUpdatedCity) {
    const lastUpdatedCityIndex = citiesGeoJson.features.findIndex(
      (item) => item.properties.slug_name === stats.lastUpdatedCity
    );
    citiesGeoJson.features = citiesGeoJson.features.slice(lastUpdatedCityIndex);
  }

  for (let i = 0; i < citiesGeoJson.features.length; i++) {
    const currentCity = citiesGeoJson.features[i];

    console.log("Processing city:", currentCity.properties.name);

    const distances = citiesGeoJson.features.map((targetCity) => ({
      city: targetCity,
      distance: turf.distance(currentCity.geometry, targetCity.geometry, {
        units: "kilometers",
      }),
    }));

    const closestCities = distances
      .filter(
        (item) => item.city.properties.name !== currentCity.properties.name
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    const coordinates = closestCities
      .map((item) => item.city.geometry.coordinates.join(","))
      .join(";");

    const routeToUrl = `http://router.project-osrm.org/table/v1/driving/${currentCity.geometry.coordinates.join(
      ","
    )};${coordinates}?annotations=distance&sources=0`;

    try {
      const { distances: distancesTo } = await (await fetch(routeToUrl)).json();

      const distanceToFeatures = closestCities.map((item, index) => ({
        type: "Feature",
        geometry: turf.lineOffset(
          turf.lineString([
            currentCity.geometry.coordinates,
            item.city.geometry.coordinates,
          ]),
          1
        ).geometry,
        properties: {
          from: currentCity.properties.slug_name,
          to: item.city.properties.slug_name,
          distance: item.distance,
          routeDistance: distancesTo[0][index + 1] / 1000,
          ratio: distancesTo[0][index + 1] / 1000 / item.distance,
        },
      }));

      await delay(2000);

      const { distances: distancesFrom } = await (
        await fetch(routeToUrl)
      ).json();

      const distanceFromFeatures = closestCities.map((item, index) => ({
        type: "Feature",
        geometry: turf.lineOffset(
          turf.lineString([
            item.city.geometry.coordinates,
            currentCity.geometry.coordinates,
          ]),
          1
        ).geometry,
        properties: {
          from: item.city.properties.slug_name,
          to: currentCity.properties.slug_name,
          distance: item.distance,
          routeDistance: distancesFrom[0][index + 1] / 1000,
          ratio: distancesFrom[0][index + 1] / 1000 / item.distance,
        },
      }));

      const mergedDistanceFeatures = [
        ...distanceToFeatures,
        ...distanceFromFeatures,
      ].map((item) => {
        const { ratio } = item.properties;
        const flag = ratio > 2 ? "red" : ratio > 1.5 ? "yellow" : "green";
        return {
          ...item,
          properties: {
            ...item.properties,
            flag,
            stroke: FLAG_COLORS[flag] || "#000",
          },
        };
      });

      try {
        const routesGeojson = await fs.readJson(ROUTES_GEOJSON_FILE);

        // Remove duplicated features
        const mergedDistanceFeaturesIds = mergedDistanceFeatures.map(
          (item) => item.properties.from + item.properties.to
        );
        routesGeojson.features = routesGeojson.features.filter(
          (item) =>
            !mergedDistanceFeaturesIds.includes(
              item.properties.from + item.properties.to
            )
        );

        routesGeojson.features = [
          ...routesGeojson.features,
          ...mergedDistanceFeatures,
        ];
        await fs.writeJson(ROUTES_GEOJSON_FILE, routesGeojson);

        const stats = {
          totalFeatures: routesGeojson.features.length,
          totalCities: routesGeojson.features.length / 10,
          totalRoutes: routesGeojson.features.length / 2,
          lastUpdatedCity: currentCity.properties.slug_name,
          updatedAt: new Date().toISOString(),
          flagCount: routesGeojson.features.reduce(
            (acc, item) => ({
              ...acc,
              [item.properties.flag]: (acc[item.properties.flag] || 0) + 1,
            }),
            {}
          ),
        };
        await fs.writeJson(STATS_FILE, stats, { spaces: 2 });

        console.log("Finished processing city:", currentCity.properties.name);
      } catch (error) {
        await saveGeoJsonToFile(ROUTES_GEOJSON_FILE, {
          type: "FeatureCollection",
          features: mergedDistanceFeatures,
        });
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
    }

    await delay(10000);
  }
}

main();
