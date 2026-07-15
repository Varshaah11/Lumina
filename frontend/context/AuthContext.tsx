"use client";

import React, { createContext, useState, useEffect, ReactNode } from "react";
import Cookies from "js-cookie";
import { User, authService, LoginData, RegisterData } from "@/services/auth";

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginData) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load token and fetch user on initial mount
  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = Cookies.get("token");
      if (storedToken) {
        setToken(storedToken);
        try {
          const userData = await authService.getMe();
          setUser(userData);
        } catch (error) {
          // If token is invalid/expired
          Cookies.remove("token");
          setToken(null);
          setUser(null);
        }
      }
      setIsLoading(false);
    };

    initializeAuth();
  }, []);

  const login = async (data: LoginData) => {
    const response = await authService.login(data);
    const newToken = response.access_token;
    
    // Store token
    Cookies.set("token", newToken, { expires: 7 }); // 7 days
    setToken(newToken);
    
    // Fetch and set user
    const userData = await authService.getMe();
    setUser(userData);
  };

  const register = async (data: RegisterData) => {
    await authService.register(data);
    // Automatically login after successful registration
    await login({ email: data.email, password: data.password });
  };

  const logout = () => {
    Cookies.remove("token");
    setToken(null);
    setUser(null);
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user && !!token,
        isLoading,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
