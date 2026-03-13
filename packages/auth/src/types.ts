export interface Identity {
  id: string;
  type: "human" | "agent" | "presence";
  name?: string;
  handle?: string;
  tier?: "soft" | "preliminary" | "established";
}

export interface AuthResult {
  identity: Identity;
}

export interface AuthError {
  error: string;
  status: number;
}
