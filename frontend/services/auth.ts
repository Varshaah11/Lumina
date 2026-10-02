import { api } from "./api";
import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export type LoginData = z.infer<typeof loginSchema>;
export type RegisterData = z.infer<typeof registerSchema>;

export interface User {
  id: string | number;
  email: string;
  name?: string;
  location?: string | null;
  bio?: string | null;
  created_at?: string;
  updated_at?: string;
}

// The JWT is never returned to JS: the backend stores it in an HttpOnly cookie.
export interface LoginResponse {
  message: string;
  token_type: string;
}

export const authService = {
  async login(data: LoginData): Promise<LoginResponse> {
    const params = new URLSearchParams();
    params.append("username", data.email);
    params.append("password", data.password);

    return api<LoginResponse>("/auth/login", {
      method: "POST",
      body: params,
    });
  },

  async register(data: RegisterData): Promise<User> {
    return api<User>("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: data.email,
        password: data.password,
        name: data.name,
      }),
    });
  },

  async logout(): Promise<void> {
    await api<unknown>("/auth/logout", { method: "POST" });
  },

  async getMe(): Promise<User> {
    return api<User>("/auth/me", {
      method: "GET",
    });
  },

  async getProfile(): Promise<User> {
    return api<User>("/auth/profile", {
      method: "GET",
    });
  },

  async updateProfile(data: { name?: string; location?: string | null; bio?: string | null }): Promise<User> {
    return api<User>("/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
};
