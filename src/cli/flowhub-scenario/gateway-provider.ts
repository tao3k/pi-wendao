import http from "node:http";
import https from "node:https";
import { parseFlowhubScenarioRegistryJson } from "./registry.js";
import type {
  FlowhubGatewayRegistryProviderOptions,
  FlowhubScenarioRegistryProvider,
} from "./types.js";

const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;

export function createGatewayFlowhubScenarioRegistryProvider(
  options: FlowhubGatewayRegistryProviderOptions,
): FlowhubScenarioRegistryProvider {
  const url = options.url.trim();
  if (!url) throw new Error("Flowhub Gateway registry URL cannot be empty");
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  return {
    async loadRegistry() {
      const body = await fetchRegistryBody(url, timeoutMs);
      return parseFlowhubScenarioRegistryJson(body);
    },
  };
}

export function resolveGatewayFlowhubRegistryProviderFromEnv():
  | FlowhubScenarioRegistryProvider
  | undefined {
  const url = readGatewayRegistryUrlFromEnv();
  if (!url) return undefined;
  return createGatewayFlowhubScenarioRegistryProvider({
    url,
    timeoutMs: parseOptionalPositiveInteger(
      process.env.PI_WENDAO_FLOWHUB_REGISTRY_TIMEOUT_MS,
    ),
  });
}

function readGatewayRegistryUrlFromEnv(): string | undefined {
  const piWendaoUrl = process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL?.trim();
  if (piWendaoUrl) return piWendaoUrl;
  const qianjiUrl = process.env.QIANJI_FLOWHUB_REGISTRY_URL?.trim();
  if (qianjiUrl) return qianjiUrl;
  const piWendaoServerUrl = process.env.PI_WENDAO_QIANJI_SERVER_URL?.trim();
  if (piWendaoServerUrl) return flowhubRegistryUrlFromServerUrl(piWendaoServerUrl);
  const qianjiServerUrl = process.env.QIANJI_SERVER_URL?.trim();
  if (qianjiServerUrl) return flowhubRegistryUrlFromServerUrl(qianjiServerUrl);
  return undefined;
}

function flowhubRegistryUrlFromServerUrl(serverUrl: string): string {
  const base = serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
  return new URL("flowhub/scenarios", base).toString();
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_GATEWAY_TIMEOUT_MS;
  if (Number.isInteger(timeoutMs) && timeoutMs > 0) return timeoutMs;
  throw new Error(
    "Flowhub Gateway registry timeout must be a positive integer",
  );
}

function parseOptionalPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(
    "PI_WENDAO_FLOWHUB_REGISTRY_TIMEOUT_MS must be a positive integer",
  );
}

function fetchRegistryBody(url: string, timeoutMs: number): Promise<string> {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "https:" ? https : http;
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Flowhub Gateway registry URL must use http or https");
  }

  return new Promise((resolve, reject) => {
    const request = transport.get(
      parsedUrl,
      {
        headers: {
          accept: "application/json",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                formatHttpFailure(statusCode, body),
              ),
            );
            return;
          }
          resolve(body);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(
          `Flowhub Gateway registry request timed out after ${timeoutMs} ms`,
        ),
      );
    });
    request.on("error", reject);
  });
}

function formatHttpFailure(statusCode: number, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Flowhub Gateway registry request failed with HTTP ${statusCode}`;
  }
  return `Flowhub Gateway registry request failed with HTTP ${statusCode}: ${trimmed.slice(0, 500)}`;
}
