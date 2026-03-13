export interface Identity {
  id: string;
  type: "human" | "agent" | "presence";
  name?: string;
  handle?: string;
  tier?: "soft" | "hard";
}

export interface AuthResult {
  identity: Identity;
}

export interface AuthError {
  error: string;
  status: number;
}
