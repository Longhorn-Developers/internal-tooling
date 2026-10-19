import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { registerCourseOverview } from "./tools/course-overview";
import { registerDiningTools } from "./tools/dining";
import { registerRateMyProfessor } from "./tools/rate-my-professor";

function createServer() {
    const server = new McpServer({
        name: "Longhorn Developers",
        version: "1.0.0",
    });
    registerCourseOverview(server);
    registerDiningTools(server);
    registerRateMyProfessor(server);
    return server;
}

const handler = createMcpHandler(createServer, {
    route: "/",
    // Setting this opts out of the library's localhost default, so `wrangler dev`
    // is rejected unless the loopback names sit alongside production.
    allowedHostnames: ["mcp.longhorndevelopers.org", "localhost", "127.0.0.1"],
});

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return handler(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
