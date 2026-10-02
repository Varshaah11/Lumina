"use client";

import React, { createContext, useState, useEffect, ReactNode } from "react";
import { User, authService, LoginData, RegisterData } from "@/services/auth";

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginData) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (updatedUser: User) => void;
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const userData = await authService.getMe();
      setUser(userData);
    } catch {
      // Ignore refresh errors
    }
  };

  const updateUser = (updatedUser: User) => {
    setUser(updatedUser);
  };

  // Restore the session on mount: the HttpOnly cookie is invisible to JS, so ask the backend who we are
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        const userData = await authService.getMe();
        setUser(userData);
      } catch {
        // No session, or it is invalid/expired
        setUser(null);
      }
      setIsLoading(false);
    };

    initializeAuth();
  }, []);

  const login = async (data: LoginData) => {
    // The backend sets the HttpOnly auth cookie on success
    await authService.login(data);

    // Fetch and set user
    const userData = await authService.getMe();
    setUser(userData);
  };

  const register = async (data: RegisterData) => {
    await authService.register(data);
    // Automatically login after successful registration
    await login({ email: data.email, password: data.password });
  };

  const logout = async () => {
    try {
      // The backend clears the HttpOnly cookie
      await authService.logout();
    } catch {
      // Still leave the app; an unreachable backend cannot be told to clear the cookie
    }
    setUser(null);
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout,
        updateUser,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
