export type UpdateSafety = {
  activeRunCount: number;
  activeRunIds: string[];
  backgroundWork: string[];
  hasUnsavedSettings: boolean;
  settingsFingerprint: string | null;
  transientBusy: boolean;
};

export type AppUpdateProps = {
  enabled: boolean;
  safety: UpdateSafety;
  verifyInstallSafety?: () => Promise<UpdateSafety>;
  prepareForInstall: () => Promise<() => Promise<void>>;
  onInstallLockChange?: (locked: boolean) => void;
  onActionError: (message: string) => void;
};
