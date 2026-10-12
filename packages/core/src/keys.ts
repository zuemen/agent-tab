import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

// Ed25519 keys travel as base64url of the raw 32-byte key (JWK "x" / "d").
export interface AgentKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: String(publicKey.export({ format: "jwk" }).x), privateKey: String(jwk.d) };
}

function privateKeyObject(keys: AgentKeyPair): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: keys.publicKey, d: keys.privateKey }, format: "jwk" });
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

export function signBytes(keys: AgentKeyPair, data: string): string {
  return sign(null, Buffer.from(data, "utf8"), privateKeyObject(keys)).toString("base64url");
}

export function verifyBytes(publicKey: string, data: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(data, "utf8"), publicKeyObject(publicKey), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
