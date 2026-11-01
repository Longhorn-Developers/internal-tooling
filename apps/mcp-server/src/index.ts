import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { registerCourseOverview } from "./tools/course-overview/index.ts";
import { registerRateMyProfessor } from "./tools/rate-my-professor/index.ts";

function createServer() {
    const server = new McpServer({
        name: "Longhorn Developers",
        version: "1.0.0",
    });
    registerCourseOverview(server);
    registerRateMyProfessor(server);
    return server;
}

const handler = createMcpHandler(createServer, {
    route: "/",
    allowedHostnames: ["mcp.longhorndevelopers.org"],
});

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return handler(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
