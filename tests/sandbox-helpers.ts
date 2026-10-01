import { realpathSync } from "node:fs";
import { registerSandbox, type SandboxOptions } from "../src/sandbox.ts";

export function sandboxHost(cwd: string, options: SandboxOptions = {}) {
	const tools = new Map<string, any>();
	const events = new Map<string, Array<(...args: any[]) => any>>();
	const pi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (name: string, handler: (...args: any[]) => any) => events.set(name, [...(events.get(name) ?? []), handler]),
	};
	const ctx: any = { cwd: realpathSync(cwd), hasUI: false };
	const handle = registerSandbox(pi, { ...options, cwd });
	return {
		handle, tools,
		async emit(event: string, payload: any = {}) {
			let result: any;
			for (const handler of events.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
			return result;
		},
		async call(name: string, params: any, signal?: AbortSignal) {
			const guard = await this.emit("tool_call", { toolName: name, input: params });
			if (guard?.block) throw new Error(guard.reason);
			return tools.get(name).execute("test", params, signal, undefined, ctx);
		},
	};
}
