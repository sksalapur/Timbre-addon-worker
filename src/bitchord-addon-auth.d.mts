export interface BitChordAuthOptions {
  hosts: string[];
  maxProofAgeSeconds?: number;
  clockSkewSeconds?: number;
}

export interface BitChordAuthResult {
  ok: boolean;
  status?: number;
  error?: string;
  message?: string;
  claims?: {
    sub?: string;
    ver?: number;
    exp?: number;
    sl?: string;
  };
}

export interface BitChordRejection {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface BitChordAuth {
  verify(credentials: { token?: string | null; proof?: string | null }): Promise<BitChordAuthResult>;
  verifyRequest(req: Request | any): Promise<BitChordAuthResult>;
  rejection(result: BitChordAuthResult): BitChordRejection;
  express(): (req: any, res: any, next: any) => Promise<void>;
  guard(request: Request): Promise<Response | null>;
}

export function createBitChordAuth(options: BitChordAuthOptions): BitChordAuth;
export const BITCHORD_AUTH_ISSUER: string;
export const BITCHORD_AUTH_AUDIENCE: string;
export const TOKEN_HEADER: string;
export const PROOF_HEADER: string;
