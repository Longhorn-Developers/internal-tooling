import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
	const server = new McpServer({
		name: "Longhorn Developers",
		version: "1.0.0",
	});

	// TODO: boilerplate!
	server.registerTool(
		"calculate",
		{
			title: "Calculate",
			description: "Perform a basic arithmetic operation on two numbers",
			inputSchema: z.object({
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			}),
			outputSchema: z.union([z.object({ result: z.number() }), z.object({ error: z.string() })]),
		},
		async ({ operation, a, b }) => {
			let result: number;
			switch (operation) {
				case "add":
					result = a + b;
					break;
				case "subtract":
					result = a - b;
					break;
				case "multiply":
					result = a * b;
					break;
				case "divide":
					if (b === 0) {
						const output = { error: "Cannot divide by zero" };
						return {
							content: [{ type: 'text', text: JSON.stringify(output) }],
							structuredContent: output
						};
					}
					result = a / b;
					break;
			}

			const output = { result };
			return {
				content: [{ type: 'text', text: JSON.stringify(output) }],
				structuredContent: output
			};
		},
	);

	return server;
}

const handler = createMcpHandler(createServer, {
	route: '/',
	allowedHostnames: [ 'longhorndevelopers.org' ]
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
