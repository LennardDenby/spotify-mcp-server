import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';

const host = process.env.MCP_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.MCP_PORT ?? '6768', 10);
const ssePath = '/sse';
const messagePath = '/messages';

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
  transport: SSEServerTransport;
};

const sessions = new Map<string, Session>();

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
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeText(res: ServerResponse, statusCode: number, body: string) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getPathname(req: IncomingMessage) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
}

function getQuerySessionId(req: IncomingMessage) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('sessionId');
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = getPathname(req);

    if (req.method === 'GET' && pathname === '/') {
      writeText(res, 200, 'Spotify MCP server is running');
      return;
    }

    if (req.method === 'GET' && pathname === ssePath) {
      setCorsHeaders(res);

      const server = createMcpServer();
      const transport = new SSEServerTransport(messagePath, res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, { server, transport });

      transport.onclose = () => {
        sessions.delete(sessionId);
      };

      await server.connect(transport);
      return;
    }

    if (req.method === 'POST' && pathname === messagePath) {
      setCorsHeaders(res);

      const sessionId = getQuerySessionId(req);
      if (!sessionId) {
        writeText(res, 400, 'Missing sessionId parameter');
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        writeText(res, 404, 'Session not found');
        return;
      }

      const body = await readJsonBody(req);
      await session.transport.handlePostMessage(req, res, body);
      return;
    }

    if (pathname === ssePath || pathname === messagePath || pathname === '/') {
      writeText(res, 405, 'Method not allowed');
      return;
    }

    writeText(res, 404, 'Not found');
    return;

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
    console.log(`SSE endpoint: http://${host}:${port}${ssePath}`);
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
