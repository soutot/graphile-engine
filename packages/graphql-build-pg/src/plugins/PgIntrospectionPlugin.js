import withPgClient from "../withPgClient";
import { readFile as rawReadFile } from "fs";
import pg from "pg";
import debugFactory from "debug";
const debug = debugFactory("graphql-build-pg");
const INTROSPECTION_PATH = `${__dirname}/../../res/introspection-query.sql`;
const WATCH_FIXTURES_PATH = `${__dirname}/../../res/watch-fixtures.sql`;

function readFile(filename, encoding) {
  return new Promise((resolve, reject) => {
    rawReadFile(filename, encoding, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export default async function PgIntrospectionPlugin(
  builder,
  { pgConfig, pgSchemas: schemas }
) {
  async function introspect() {
    return withPgClient(pgConfig, async pgClient => {
      // Perform introspection
      if (!Array.isArray(schemas)) {
        throw new Error("Argument 'schemas' (array) is required");
      }
      const introspectionQuery = await readFile(INTROSPECTION_PATH, "utf8");
      const { rows } = await pgClient.query(introspectionQuery, [schemas]);

      const introspectionResultsByKind = rows.reduce(
        (memo, { object }) => {
          memo[object.kind].push(object);
          return memo;
        },
        {
          namespace: [],
          class: [],
          attribute: [],
          type: [],
          constraint: [],
          procedure: [],
        }
      );
      const xByY = (arrayOfX, attrKey) =>
        arrayOfX.reduce((memo, x) => {
          memo[x[attrKey]] = x;
          return memo;
        }, {});
      const xByYAndZ = (arrayOfX, attrKey, attrKey2) =>
        arrayOfX.reduce((memo, x) => {
          memo[x[attrKey]] = memo[x[attrKey]] || {};
          memo[x[attrKey]][x[attrKey2]] = x;
          return memo;
        }, {});
      introspectionResultsByKind.namespaceById = xByY(
        introspectionResultsByKind.namespace,
        "id"
      );
      introspectionResultsByKind.classById = xByY(
        introspectionResultsByKind.class,
        "id"
      );
      introspectionResultsByKind.typeById = xByY(
        introspectionResultsByKind.type,
        "id"
      );
      introspectionResultsByKind.attributeByClassIdAndNum = xByYAndZ(
        introspectionResultsByKind.attribute,
        "classId",
        "num"
      );

      const relate = (
        array,
        newAttr,
        lookupAttr,
        lookup,
        missingOk = false
      ) => {
        array.forEach(entry => {
          const key = entry[lookupAttr];
          const result = lookup[key];
          if (key && !result) {
            if (missingOk) {
              return;
            }
            throw new Error(
              `Could not look up '${newAttr}' by '${lookupAttr}' on '${JSON.stringify(
                entry
              )}'`
            );
          }
          entry[newAttr] = result;
        });
      };

      relate(
        introspectionResultsByKind.class,
        "namespace",
        "namespaceId",
        introspectionResultsByKind.namespaceById,
        true // Because it could be a type defined in a different namespace - which is fine so long as we don't allow querying it directly
      );

      relate(
        introspectionResultsByKind.class,
        "type",
        "typeId",
        introspectionResultsByKind.typeById
      );

      relate(
        introspectionResultsByKind.attribute,
        "class",
        "classId",
        introspectionResultsByKind.classById
      );

      relate(
        introspectionResultsByKind.attribute,
        "type",
        "typeId",
        introspectionResultsByKind.typeById
      );

      relate(
        introspectionResultsByKind.procedure,
        "namespace",
        "namespaceId",
        introspectionResultsByKind.namespaceById
      );

      relate(
        introspectionResultsByKind.type,
        "class",
        "classId",
        introspectionResultsByKind.classById,
        true
      );

      relate(
        introspectionResultsByKind.type,
        "domainBaseType",
        "domainBaseTypeId",
        introspectionResultsByKind.typeById,
        true // Because not all types are domains
      );

      relate(
        introspectionResultsByKind.type,
        "arrayItemType",
        "arrayItemTypeId",
        introspectionResultsByKind.typeById,
        true // Because not all types are arrays
      );

      return introspectionResultsByKind;
    });
  }

  let introspectionResultsByKind = await introspect();

  let pgClient, releasePgClient, listener;

  function stopListening() {
    if (pgClient) {
      pgClient.query("unlisten postgraphql_watch").catch(e => {
        debug(`Error occurred trying to unlisten watch: ${e}`);
      });
      pgClient.removeListener("notification", listener);
    }
    if (releasePgClient) {
      releasePgClient();
      pgClient = null;
    }
  }

  builder.registerWatcher(async triggerRebuild => {
    // In case we started listening before, clean up
    await stopListening();

    // Check we can get a pgClient
    if (pgConfig instanceof pg.Pool) {
      pgClient = await pgConfig.connect();
      releasePgClient = () => pgClient.release();
    } else if (typeof pgConfig === "string") {
      pgClient = new pg.Client(pgConfig);
      pgClient.on("error", e => {
        debug("pgClient error occurred: %s", e);
      });
      releasePgClient = () =>
        new Promise((resolve, reject) =>
          pgClient.end(err => (err ? reject(err) : resolve()))
        );
      await new Promise((resolve, reject) =>
        pgClient.connect(err => (err ? reject(err) : resolve()))
      );
    } else {
      throw new Error(
        "Cannot watch schema with this configuration - need a string or pg.Pool"
      );
    }
    // Install the watch fixtures.
    const watchSqlInner = await readFile(WATCH_FIXTURES_PATH, "utf8");
    const sql = `begin; ${watchSqlInner}; commit;`;
    try {
      await pgClient.query(sql);
    } catch (error) {
      /* eslint-disable no-console */
      console.warn("Failed to setup watch fixtures in Postgres database");
      console.warn(
        "This is likely because your Postgres user is not a superuser. If the fixtures already exist, the watch functionality may still work."
      );
      console.warn(error);
      /* eslint-enable no-console */
      await pgClient.query("rollback");
    }

    await pgClient.query("listen postgraphql_watch");

    const handleChange = async () => {
      debug(`Schema change detected: re-inspecting schema...`);
      introspectionResultsByKind = await introspect();
      debug(`Schema change detected: re-inspecting schema complete`);
      triggerRebuild();
    };

    listener = async notification => {
      if (notification.channel !== "postgraphql_watch") {
        return;
      }
      try {
        const payload = JSON.parse(notification.payload);
        payload.payload = payload.payload || [];
        if (payload.type === "ddl") {
          const commands = payload.payload
            .filter(
              ({ schema }) => schema == null || schemas.indexOf(schema) >= 0
            )
            .map(({ command }) => command);
          if (commands.length) {
            handleChange();
          }
        } else if (payload.type === "drop") {
          const affectsOurSchemas = payload.payload.some(
            schemaName => schemas.indexOf(schemaName) >= 0
          );
          if (affectsOurSchemas) {
            handleChange();
          }
        } else {
          throw new Error(`Payload type '${payload.type}' not recognised`);
        }
      } catch (e) {
        debug(`Error occurred parsing notification payload: ${e}`);
      }
    };
    pgClient.on("notification", listener);
    introspectionResultsByKind = await introspect();
  }, stopListening);

  builder.hook("build", build => {
    return build.extend(build, {
      pgIntrospectionResultsByKind: introspectionResultsByKind,
    });
  });
}
