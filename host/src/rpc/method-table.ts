import type { MethodTable } from "./dispatcher";

/**
 * The dispatch table wired into the running host by `main.ts`. Empty at this
 * task: Tasks 8-11 each register their domain methods here. Every floor
 * method not yet present in this map is still advertised in the manifest
 * (`handshake/rpc-handshake.ts`'s `buildHostManifest`), so a request for one
 * of them reaches `createDispatcher`'s unknown-method path — logged and
 * answered with `RPC_ERROR`, never silently dropped — until its task lands.
 */
export const methodTable: MethodTable = new Map();
