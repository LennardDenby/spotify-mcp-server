import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';

const host = process.env.MCP_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.MCP_PORT ?? '6768', 10);
const endpointPaths = new Set(['/', '/mcp']);

function createMcpServer() {
  const server = new McpServer({
    name: 'spotify-controller',
    version: '1.0.0',
  });

  [...readTools, ...playTools, ...albumTools, ...playlistTools].forEach((tool) => {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  });

  return server;
}

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, Session>();

function isInitializeRequest(body: unknown): body is { method: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'method' in body &&
    typeof (body as { method?: unknown }).method === 'string' &&
    (body as { method: string }).method === 'initialize'
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8').trim();
  return body.length === 0 ? undefined : JSON.parse(body);
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeText(res: ServerResponse, statusCode: number, body: string) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function getSessionId(req: IncomingMessage) {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

function getPathname(req: IncomingMessage) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const pathname = getPathname(req);
    if (!endpointPaths.has(pathname)) {
      writeText(res, 404, 'Not found');
      return;
    }

    if (req.method === 'GET') {
      const sessionId = getSessionId(req);
      if (!sessionId) {
        writeText(res, 200, 'Spotify MCP server is running');
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        writeText(res, 400, 'Invalid or missing session ID');
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const sessionId = getSessionId(req);

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          });
          return;
        }

        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        writeJson(res, 400, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Session required for non-initialize requests',
          },
          id: null,
        });
        return;
      }

      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server, transport });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'DELETE') {
      const sessionId = getSessionId(req);
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        writeText(res, 400, 'Invalid or missing session ID');
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    writeText(res, 405, 'Method not allowed');
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Parse error',
        },
        id: null,
      });
      return;
    }

    console.error('Error handling request:', error);
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
}

async function main() {
  if (Number.isNaN(port)) {
    throw new Error(`Invalid MCP_PORT value: ${process.env.MCP_PORT}`);
  }

  const httpServer = createServer((req, res) => {
    void handleMcpRequest(req, res);
  });

  httpServer.listen(port, host, () => {
    console.log(`Spotify MCP server listening on http://${host}:${port}`);
  });

  const shutdown = async () => {
    for (const session of sessions.values()) {
      await session.server.close().catch((error) => {
        console.error('Error closing MCP session:', error);
      });
    }

    sessions.clear();
    httpServer.close((error) => {
      if (error) {
        console.error('Error shutting down HTTP server:', error);
        process.exit(1);
      }

      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
