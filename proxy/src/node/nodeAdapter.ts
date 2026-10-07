/**
 * Adapts the fetch-style ProxyHandler to node:http.
 */
import http from "node:http";
import type { ProxyHandler } from "../handler";

export interface NodeAdapterOptions {
  /** Hard cap on request bodies read from the socket (default 4 MB). */
  maxBodyBytes?: number;
  onError?: (msg: string) => void;
}

export function toNodeListener(handler: ProxyHandler, opts: NodeAdapterOptions = {}): http.RequestListener {
  const maxBody = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  return (req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? "localhost";
        const url = new URL(req.url ?? "/", `http://${host}`);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) for (const x of v) headers.append(k, x);
          else headers.set(k, v);
        }
        const method = (req.method ?? "GET").toUpperCase();
        let body: Uint8Array | undefined;
        if (method !== "GET" && method !== "HEAD") {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            const b = chunk as Buffer;
            size += b.length;
            if (size > maxBody) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "body too large" }));
              req.destroy();
              return;
            }
            chunks.push(b);
          }
          body = Buffer.concat(chunks);
        }
        const request = new Request(url, { method, headers, body });
        const response = await handler(request);
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          outHeaders[k] = v;
        });
        res.writeHead(response.status, outHeaders);
        if (response.body && method !== "HEAD") res.end(Buffer.from(await response.arrayBuffer()));
        else res.end();
      } catch (e) {
        opts.onError?.(`node adapter: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    })();
  };
}

export function startServer(handler: ProxyHandler, port: number, host = "127.0.0.1", opts: NodeAdapterOptions = {}): Promise<http.Server> {
  const server = http.createServer(toNodeListener(handler, opts));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
