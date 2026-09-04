import { $which } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import museSystemPreamble from "./muse-system.md" with { type: "text" };

interface MuseCredential {
	api_base_url: string;
	api_key: string;
	mechanism: "oauth";
}

interface RpcReadState {
	buffer: string;
	decoder: TextDecoder;
}

function authPath(): string {
	if (Bun.env.MUSE_AUTH_PATH) return Bun.env.MUSE_AUTH_PATH;
	if (Bun.env.XDG_CONFIG_HOME) return path.join(Bun.env.XDG_CONFIG_HOME, "muse", "auth.json");
	if (Bun.env.HOME) return path.join(Bun.env.HOME, ".config", "muse", "auth.json");
	throw new Error("Muse credentials cannot be located because HOME is unset.");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function loadCredential(): Promise<MuseCredential> {
	const filePath = authPath();
	let auth: unknown;
	try {
		auth = await Bun.file(filePath).json();
	} catch {
		throw new Error(
			`Muse credentials are unavailable at ${filePath}. Install Muse with ` +
				"`curl -fsSL https://dev.meta.ai/install.sh | bash`, then run `muse login`.",
		);
	}
	if (!isObject(auth) || !isObject(auth.providers) || !isObject(auth.providers.meta)) {
		throw new Error(`Muse credentials at ${filePath} have an unsupported format; run \`muse login\` again.`);
	}
	const credential = auth.providers.meta;
	if (
		credential.mechanism !== "oauth" ||
		typeof credential.api_base_url !== "string" ||
		credential.api_base_url.length === 0 ||
		typeof credential.api_key !== "string" ||
		credential.api_key.length === 0
	) {
		throw new Error(`No Meta subscription credential was found at ${filePath}; run \`muse login\` again.`);
	}
	return {
		api_base_url: credential.api_base_url,
		api_key: credential.api_key,
		mechanism: credential.mechanism,
	};
}

async function readRpcMessage(reader: ReadableStreamDefaultReader<Uint8Array>, state: RpcReadState): Promise<unknown> {
	while (true) {
		const newline = state.buffer.indexOf("\n");
		if (newline >= 0) {
			const line = state.buffer.slice(0, newline);
			state.buffer = state.buffer.slice(newline + 1);
			if (line.trim()) return JSON.parse(line) as unknown;
		}
		const chunk = await reader.read();
		if (chunk.done) throw new Error("Muse exited before returning its model catalog.");
		state.buffer += state.decoder.decode(chunk.value, { stream: true });
	}
}

function parseModels(message: unknown): ProviderModelConfig[] | undefined {
	if (!isObject(message) || message.id !== 2) return undefined;
	if (message.error) throw new Error("Muse rejected model catalog discovery.");
	if (!isObject(message.result) || !Array.isArray(message.result.models)) {
		throw new Error("Muse returned an invalid model catalog.");
	}
	const models: ProviderModelConfig[] = [];
	for (const value of message.result.models) {
		if (
			!isObject(value) ||
			typeof value.modelId !== "string" ||
			typeof value.displayLabel !== "string" ||
			typeof value.contextLimit !== "number" ||
			!Number.isFinite(value.contextLimit) ||
			value.contextLimit <= 0 ||
			typeof value.outputLimit !== "number" ||
			!Number.isFinite(value.outputLimit) ||
			value.outputLimit <= 0
		) {
			throw new Error("Muse returned an invalid model catalog entry.");
		}
		models.push({
			id: value.modelId,
			name: value.displayLabel,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: value.contextLimit,
			maxTokens: value.outputLimit,
		});
	}
	if (models.length === 0) throw new Error("Muse returned an empty model catalog.");
	return models;
}

async function discoverModels(): Promise<ProviderModelConfig[]> {
	const executable = $which("muse");
	if (!executable) {
		throw new Error("Muse is not installed; run `curl -fsSL https://dev.meta.ai/install.sh | bash`.");
	}
	const child = Bun.spawn([executable, "serve", "--no-session-log", "--disable-shell", "--disable-write"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const reader = child.stdout.getReader();
	const state: RpcReadState = { buffer: "", decoder: new TextDecoder() };
	try {
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "muse_subscription", version: "1" } } })}\n`,
		);
		await child.stdin.flush();
		while (true) {
			const message = await readRpcMessage(reader, state);
			if (!isObject(message) || message.id !== 1) continue;
			if (message.error) throw new Error("Muse rejected model discovery initialization.");
			break;
		}
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} })}\n`);
		await child.stdin.flush();
		while (true) {
			const models = parseModels(await readRpcMessage(reader, state));
			if (models) return models;
		}
	} finally {
		child.kill();
		await child.exited;
	}
}

export default async function (pi: ExtensionAPI) {
	const credential = await loadCredential();
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.model.provider !== "muse") return;
		return { systemPrompt: [museSystemPreamble, ...event.systemPrompt] };
	});

	pi.registerProvider("muse", {
		baseUrl: credential.api_base_url,
		apiKey: credential.api_key,
		api: "openai-responses",
		models: await discoverModels(),
		fetchDynamicModels: discoverModels,
	});
}
