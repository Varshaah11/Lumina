"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Mail,
  MapPin,
  Lock,
  Edit2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Check,
  Calendar,
  Shield,
  Sparkles,
  ArrowRight,
} from "lucide-react";

interface ProfileState {
  name: string;
  location: string;
  bio: string;
}

const getInitialProfile = (
  user?: { id?: string | number; email?: string; name?: string } | null
): ProfileState => {
  let savedProfile: Partial<ProfileState> = {};
  if (typeof window !== "undefined" && user) {
    const storageKey = `lumina_profile_${user.id || user.email || "default"}`;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        savedProfile = JSON.parse(stored);
      }
    } catch {
      // Ignore localStorage parse errors
    }
  }
  return {
    name: savedProfile.name !== undefined ? savedProfile.name : user?.name || "",
    location: savedProfile.location || "",
    bio: savedProfile.bio || "",
  };
};

export default function ProfilePage() {
  const { user, isLoading } = useAuth();

  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [profile, setProfile] = useState<ProfileState>(() => getInitialProfile(user));
  const [formData, setFormData] = useState<ProfileState>(() => getInitialProfile(user));
  const [prevUserId, setPrevUserId] = useState<string | number | undefined>(user?.id);

  if (user && user.id !== prevUserId) {
    setPrevUserId(user.id);
    const resolved = getInitialProfile(user);
    setProfile(resolved);
    setFormData(resolved);
  }

  const nameInputRef = useRef<HTMLInputElement>(null);
  const successTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  // Auto-focus name input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setTimeout(() => {
        nameInputRef.current?.focus();
      }, 50);
    }
  }, [isEditing]);

  const handleCancel = useCallback(() => {
    setFormData(profile);
    setErrorMessage(null);
    setIsEditing(false);
  }, [profile]);

  const handleEnterEdit = () => {
    setFormData(profile);
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsEditing(true);
  };

  // Handle keyboard Escape to cancel editing
  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSaving) {
        handleCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, isSaving, handleCancel]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;

    const trimmedName = formData.name.trim();
    if (!trimmedName) {
      setErrorMessage("Full Name is required.");
      nameInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      // Simulate asynchronous state persist
      await new Promise((resolve) => setTimeout(resolve, 300));

      const updatedProfile: ProfileState = {
        name: trimmedName,
        location: formData.location.trim(),
        bio: formData.bio.trim(),
      };

      if (user) {
        const storageKey = `lumina_profile_${user.id || user.email || "default"}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedProfile));
      }

      setProfile(updatedProfile);
      setIsEditing(false);

      setSuccessMessage("Profile changes saved successfully.");
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
      }
      successTimerRef.current = setTimeout(() => {
        setSuccessMessage(null);
      }, 4000);
    } catch {
      setErrorMessage("Failed to save profile changes. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const getInitials = (name?: string) => {
    if (!name || !name.trim()) return "U";
    const parts = name.trim().split(" ");
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  };

  const formattedJoinDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
      })
    : null;

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto pb-12 w-full space-y-6">
        {/* Page Header */}
        <PageHeader
          title="Profile"
          description="Manage your personal information and account settings."
          action={
            !isEditing && !isLoading ? (
              <Button
                type="button"
                onClick={handleEnterEdit}
                aria-label="Edit Profile"
                className="group bg-white/5 hover:bg-white/10 border border-white/10 hover:border-indigo-500/40 text-gray-200 hover:text-white active:scale-95 transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 cursor-pointer text-xs sm:text-sm h-9 px-4 rounded-xl flex items-center gap-2"
              >
                <Edit2 className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-300 transition-colors" />
                <span>Edit Profile</span>
              </Button>
            ) : null
          }
        />

        {/* Centered Main Profile Container */}
        <div className="relative bg-white/[0.02] border border-white/10 rounded-3xl p-6 sm:p-8 md:p-10 backdrop-blur-xl shadow-2xl shadow-indigo-500/5 overflow-hidden transition-all">
          {/* Ambient subtle glow accents inside card */}
          <div
            className="absolute -top-32 -right-32 w-64 h-64 rounded-full bg-indigo-500/10 blur-[90px] pointer-events-none"
            aria-hidden="true"
          />
          <div
            className="absolute -bottom-32 -left-32 w-64 h-64 rounded-full bg-purple-500/10 blur-[90px] pointer-events-none"
            aria-hidden="true"
          />

          {isLoading ? (
            /* Skeleton Loading State */
            <div className="space-y-8 animate-pulse">
              <div className="flex flex-col items-center text-center">
                <Skeleton className="w-24 h-24 rounded-full bg-white/10 mb-4" />
                <Skeleton className="h-6 w-44 bg-white/10 mb-2 rounded-lg" />
                <Skeleton className="h-4 w-60 bg-white/5 rounded-md" />
              </div>
              <div className="h-px w-full bg-white/5" />
              <div className="space-y-6">
                <div>
                  <Skeleton className="h-3 w-20 bg-white/10 mb-2 rounded" />
                  <Skeleton className="h-11 w-full bg-white/5 rounded-xl" />
                </div>
                <div>
                  <Skeleton className="h-3 w-28 bg-white/10 mb-2 rounded" />
                  <Skeleton className="h-11 w-full bg-white/5 rounded-xl" />
                </div>
                <div>
                  <Skeleton className="h-3 w-16 bg-white/10 mb-2 rounded" />
                  <Skeleton className="h-11 w-full bg-white/5 rounded-xl" />
                </div>
                <div>
                  <Skeleton className="h-3 w-12 bg-white/10 mb-2 rounded" />
                  <Skeleton className="h-24 w-full bg-white/5 rounded-xl" />
                </div>
              </div>
            </div>
          ) : (
            <div className="relative z-10">
              {/* Profile Header & Avatar */}
              <div className="flex flex-col items-center text-center mb-8">
                <div className="relative">
                  {/* Avatar Glow Ring */}
                  <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full p-[2px] bg-gradient-to-tr from-indigo-500 via-purple-500 to-indigo-400 shadow-[0_0_30px_rgba(99,102,241,0.25)] flex items-center justify-center transition-transform hover:scale-105 duration-300">
                    <div className="w-full h-full rounded-full bg-black/90 flex items-center justify-center overflow-hidden border-2 border-white/10">
                      <span className="text-3xl sm:text-4xl font-bold bg-gradient-to-br from-white via-indigo-100 to-purple-200 bg-clip-text text-transparent select-none">
                        {getInitials(profile.name || user?.name)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Display Name & Email */}
                <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight mt-4">
                  {profile.name || user?.name || "Lumina User"}
                </h2>
                <div className="text-xs sm:text-sm text-gray-400 mt-1 flex items-center justify-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-zinc-500" />
                  <span>{user?.email}</span>
                </div>

                {formattedJoinDate && (
                  <div className="mt-2.5 inline-flex items-center gap-1.5 text-[11px] text-zinc-500 bg-white/[0.03] border border-white/5 px-2.5 py-0.5 rounded-full">
                    <Calendar className="w-3 h-3 text-zinc-400" />
                    <span>Member since {formattedJoinDate}</span>
                  </div>
                )}
              </div>

              {/* Status Announcements */}
              {successMessage && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-6 flex items-center gap-2.5 p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs sm:text-sm animate-in fade-in slide-in-from-top-2 duration-200"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{successMessage}</span>
                </div>
              )}

              {errorMessage && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="mb-6 flex items-center gap-2.5 p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs sm:text-sm animate-in fade-in slide-in-from-top-2 duration-200"
                >
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Thin Divider */}
              <div className="h-px w-full bg-white/5 mb-8" />

              {/* VIEW MODE */}
              {!isEditing ? (
                <div className="space-y-6">
                  {/* Full Name */}
                  <div>
                    <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Full Name
                    </span>
                    <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 text-sm sm:text-base text-gray-200 font-medium">
                      {profile.name || user?.name || (
                        <span className="text-zinc-500 italic font-normal">Not set</span>
                      )}
                    </div>
                  </div>

                  {/* Email Address */}
                  <div>
                    <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Email Address
                    </span>
                    <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 text-sm sm:text-base text-gray-200 font-medium flex items-center justify-between">
                      <span className="truncate mr-2">{user?.email}</span>
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                        <Lock className="w-3 h-3 text-zinc-500" /> Account
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1.5 ml-1">
                      Account email is linked to your login credentials and is read-only.
                    </p>
                  </div>

                  {/* Location */}
                  <div>
                    <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Location
                    </span>
                    <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 text-sm sm:text-base text-gray-200">
                      {profile.location ? (
                        <div className="flex items-center gap-2 text-gray-200 font-medium">
                          <MapPin className="w-4 h-4 text-indigo-400 shrink-0" />
                          <span>{profile.location}</span>
                        </div>
                      ) : (
                        <span className="text-zinc-500 italic text-sm">Not specified</span>
                      )}
                    </div>
                  </div>

                  {/* Bio */}
                  <div>
                    <span className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Bio
                    </span>
                    <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 text-sm text-gray-300 min-h-[90px] leading-relaxed">
                      {profile.bio ? (
                        <p className="whitespace-pre-wrap">{profile.bio}</p>
                      ) : (
                        <span className="text-zinc-500 italic">No bio provided.</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                /* EDIT MODE */
                <form onSubmit={handleSave} className="space-y-6">
                  {/* Full Name Input */}
                  <div>
                    <label
                      htmlFor="profile-name"
                      className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2"
                    >
                      Full Name <span className="text-indigo-400">*</span>
                    </label>
                    <input
                      ref={nameInputRef}
                      id="profile-name"
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, name: e.target.value }))
                      }
                      placeholder="e.g. Alex Morgan"
                      className="w-full h-11 px-3.5 rounded-2xl bg-white/5 border border-white/10 text-white placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all"
                    />
                  </div>

                  {/* Email Address (Read-only) */}
                  <div>
                    <label
                      htmlFor="profile-email"
                      className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2"
                    >
                      Email Address
                    </label>
                    <div
                      id="profile-email"
                      className="w-full h-11 px-3.5 rounded-2xl bg-white/[0.02] border border-white/5 text-zinc-400 text-sm flex items-center justify-between cursor-not-allowed"
                    >
                      <span className="truncate mr-2">{user?.email}</span>
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                        <Lock className="w-3 h-3 text-zinc-500" /> Read-only
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1.5 ml-1">
                      Account email is linked to your authentication provider and cannot be changed here.
                    </p>
                  </div>

                  {/* Location Input (Optional) */}
                  <div>
                    <label
                      htmlFor="profile-location"
                      className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2"
                    >
                      Location <span className="text-zinc-500 text-[10px] lowercase font-normal">(optional)</span>
                    </label>
                    <div className="relative">
                      <MapPin className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="profile-location"
                        type="text"
                        value={formData.location}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, location: e.target.value }))
                        }
                        placeholder="e.g. San Francisco, CA"
                        className="w-full h-11 pl-10 pr-3.5 rounded-2xl bg-white/5 border border-white/10 text-white placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all"
                      />
                    </div>
                  </div>

                  {/* Bio Textarea (Optional) */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label
                        htmlFor="profile-bio"
                        className="text-xs font-semibold text-zinc-400 uppercase tracking-wider"
                      >
                        Bio <span className="text-zinc-500 text-[10px] lowercase font-normal">(optional)</span>
                      </label>
                      <span className="text-[11px] text-zinc-500 font-mono">
                        {formData.bio.length}/300
                      </span>
                    </div>
                    <textarea
                      id="profile-bio"
                      rows={4}
                      maxLength={300}
                      value={formData.bio}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, bio: e.target.value }))
                      }
                      placeholder="Write a brief bio about yourself or your focus in Lumina..."
                      className="w-full p-3.5 rounded-2xl bg-white/5 border border-white/10 text-white placeholder:text-zinc-500 text-sm focus:outline-none focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20 transition-all resize-none leading-relaxed"
                    />
                  </div>

                  {/* Form Action Buttons */}
                  <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3 pt-4 border-t border-white/5">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleCancel}
                      disabled={isSaving}
                      className="w-full sm:w-auto h-10 px-5 rounded-2xl text-xs sm:text-sm text-zinc-400 hover:text-white hover:bg-white/10 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={isSaving}
                      className="w-full sm:w-auto h-10 px-6 rounded-2xl text-xs sm:text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-lg shadow-indigo-500/25 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 transition-all flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      {isSaving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-white" />
                          <span>Saving Changes...</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-4 h-4 text-white" />
                          <span>Save Changes</span>
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>

        {/* Data & Privacy Section */}
        <section
          aria-labelledby="privacy-heading"
          className="bg-white/[0.02] border border-white/10 rounded-3xl p-6 sm:p-8 backdrop-blur-xl shadow-2xl shadow-indigo-500/5 relative overflow-hidden transition-all"
        >
          {/* Ambient subtle glow */}
          <div
            className="absolute -top-24 -right-24 w-48 h-48 rounded-full bg-indigo-500/5 blur-[80px] pointer-events-none"
            aria-hidden="true"
          />

          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-xl bg-white/5 text-indigo-400 border border-white/5 shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 id="privacy-heading" className="text-base sm:text-lg font-semibold text-white tracking-tight">
                Data & Privacy
              </h2>
              <p className="text-xs sm:text-sm text-gray-400">
                Manage how your conversations and uploaded documents are stored and processed.
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-white">Conversation History & Documents</h3>
              <p className="text-xs text-gray-400 mt-0.5">
                Your chats and files are private to your account. You can review or delete prior conversations anytime.
              </p>
            </div>

            <Link
              href="/history"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs sm:text-sm font-medium text-indigo-300 hover:text-white bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 hover:border-indigo-500/30 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 shrink-0 w-fit active:scale-95"
            >
              <span>Manage Chat History</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </section>

        {/* About Lumina (Compact informational footer row) */}
        <footer
          aria-label="About Lumina"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-2xl border border-white/5 bg-white/[0.015] backdrop-blur-md text-xs sm:text-sm text-gray-400"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center shrink-0 shadow-sm">
              <Sparkles className="w-3.5 h-3.5 text-white" />
            </div>
            <div>
              <span className="font-semibold text-white">Lumina</span>
              <span className="mx-2 text-zinc-600">·</span>
              <span className="text-zinc-400 text-xs">v1.0.0 (Beta)</span>
            </div>
          </div>
          <p className="text-zinc-500 text-xs">
            Intelligent AI workspace designed for professionals.
          </p>
        </footer>
      </div>
    </DashboardLayout>
  );
}
