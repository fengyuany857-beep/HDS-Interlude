import type { R1ApprovalRequest, R1ApprovalVerifier } from './authorized-outbox';
export interface R1HostApprovalIdentity {
    credentialId: string;
    principalId: string;
    publicKeyDerBase64: string;
}
/** Stable bytes signed by the trusted host. Every authority-bearing field is included. */
export declare function r1ApprovalSigningBytes(request: Omit<R1ApprovalRequest, 'signature'>): Buffer;
/** Ed25519 verifier backed only by host-configured public identities. */
export declare function createR1HostApprovalVerifier(identities: readonly R1HostApprovalIdentity[]): R1ApprovalVerifier;
