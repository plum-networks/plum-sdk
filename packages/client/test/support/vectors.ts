// Typed access to the shared oauth-issuer v3 vectors. The JSON is copied
// UNCHANGED from the design (oauth-issuer-dpop-vectors.v3.json); core,
// plumconnect and PlumConnect Swift run the same file, so it is the contract.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProofExpect {
  result: "accept" | "invalid_dpop_proof" | "invalid_grant";
  code_consumed: boolean;
  plum_retry?: "iat";
  plum_server_time?: number;
}

export interface ProofCase {
  name: string;
  bound_jkt: string;
  bound_issuer: string;
  htu: string;
  proof: string;
  expect: ProofExpect;
}

export interface VectorPending {
  state: string;
  expectation: { mode: "discover" | "known" | "dev"; issuer?: string };
  channel: "auth_tab" | "as_web_auth" | "loopback" | "custom_tab" | "external";
  redirect_uri: string;
  policy: { box_domain: string; require_verified_channel: boolean };
}

export interface CallbackStep {
  entry: "auth_tab_result" | "android_intent" | "as_web_auth" | "js_url" | "js_params" | "accept_issuer_change";
  input?: string | Record<string, string>;
  delivered?: VectorPending["channel"] | "none";
  age_s?: number;
  expect: { outcome: string; reason: string; issuer: string; match: string };
}

export interface CallbackCase {
  name: string;
  pending: VectorPending;
  steps: CallbackStep[];
}

export interface StartCase {
  name: string;
  expectation: { mode: "discover" | "known" | "dev"; issuer?: string };
  channel: VectorPending["channel"];
  policy: { box_domain: string; require_verified_channel: boolean };
  expect: { ok: boolean; error?: string; entry_prefix?: string; fragment?: string };
}

export interface Jwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

export interface Vectors {
  version: number;
  key: { d_hex: string; jwk: Jwk; thumbprint_input: string; jkt: string };
  other_key: { jwk: Jwk; jkt: string };
  now_unix: number;
  iat_window_seconds: number;
  max_proof_bytes: number;
  cases: ProofCase[];
  issuer_syntax: { accept: string[]; reject: string[] };
  dev_expectation: { accept: string[]; reject: string[] };
  callback_cases: CallbackCase[];
  start_cases: StartCase[];
  channel_for_redirect: { redirect_uri: string; channel: string }[];
}

export const VECTORS_PATH = join(__dirname, "..", "vectors", "oauth-issuer-dpop-vectors.v3.json");

export const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;
