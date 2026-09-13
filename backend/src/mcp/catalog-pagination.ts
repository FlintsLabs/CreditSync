import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

export const MCP_PAGE_SIZE = 25;

export function encodeCatalogCursor(profile: string, catalogVersion: string, offset: number) {
    return Buffer.from(JSON.stringify({ profile, catalogVersion, offset }), "utf8").toString("base64url");
}

export function decodeCatalogCursor(profile: string, catalogVersion: string, value: unknown, total: number) {
    if (typeof value !== "string") throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tools/list cursor");
    try {
        const decoded = Buffer.from(value, "base64url").toString("utf8");
        if (!decoded || Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("cursor encoding");
        const parsed = JSON.parse(decoded) as { profile?: string; catalogVersion?: string; offset?: number };
        if (parsed.profile !== profile || parsed.catalogVersion !== catalogVersion || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0 || parsed.offset! >= total) throw new Error("cursor binding");
        return parsed.offset!;
    } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tools/list cursor");
    }
}
