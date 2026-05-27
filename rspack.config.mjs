import { builtinModules, createRequire } from "node:module";
import { resolve } from "node:path";
import rspack from "@rspack/core";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json");

const externalPackages = new Set(Object.keys(packageJson.dependencies ?? {}));
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

const entries = {
  "cli/pi-wendao": "./src/cli/pi-wendao.ts",
  "arrow/ipc": "./src/arrow/ipc.ts",
  "arrow/schema": "./src/arrow/schema.ts",
  "cli/graph-intercom-extension": "./src/cli/graph-intercom-extension.ts",
  "executor/pi-subagents-runtime": "./src/executor/pi-subagents-runtime.ts",
  subagents: "./src/subagents.ts",
  "subagents/activity": "./src/subagents/activity.ts",
  "qianji-server": "./src/qianji-server.ts",
  workflows: "./src/workflows.ts",
  "wendao-server": "./src/wendao-server.ts",
  gateway: "./src/gateway.ts",
};

export default {
  mode: "production",
  target: "node22",
  entry: entries,
  output: {
    path: resolve(import.meta.dirname, "dist"),
    filename: "[name].js",
    chunkFilename: "chunks/[name].js",
    library: {
      type: "module",
    },
    module: true,
    clean: false,
  },
  experiments: {
    outputModule: true,
  },
  externalsType: "module",
  externals: [
    ({ request }, callback) => {
      if (!request) {
        callback();
        return;
      }

      if (nodeBuiltins.has(request)) {
        callback(null, request);
        return;
      }

      const packageName = packageNameFromRequest(request);
      if (packageName && externalPackages.has(packageName)) {
        callback(null, request);
        return;
      }

      callback();
    },
  ],
  module: {
    rules: [
      {
        test: /\.[cm]?ts$/u,
        exclude: /node_modules/u,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: {
              syntax: "typescript",
            },
            target: "es2022",
          },
        },
        type: "javascript/auto",
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".mjs", ".js", ".json"],
    extensionAlias: {
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
  },
  optimization: {
    minimize: false,
    runtimeChunk: false,
    splitChunks: false,
  },
  plugins: [
    new rspack.BannerPlugin({
      banner: "#!/usr/bin/env node",
      raw: true,
      entryOnly: true,
      include: /cli\/pi-wendao\.js$/u,
    }),
  ],
};

function packageNameFromRequest(request) {
  if (request.startsWith(".") || request.startsWith("/") || request.startsWith("#")) {
    return undefined;
  }

  const parts = request.split("/");
  if (request.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : request;
  }

  return parts[0];
}
