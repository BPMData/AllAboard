import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ImportRestoreMode, PendingSnapshotData, RestoreClassWork } from '../types';
import { buildSnapshotJson, parseSnapshotText, snapshotFileName, type SnapshotSource } from '../lib/roomSnapshot';
import {
  GoogleError,
  createDriveFolder,
  downloadDriveFile,
  friendlyGoogleError,
  getAccessToken,
  getDriveAccount,
  getLastDriveFolder,
  getRoomDriveSave,
  pickDriveFile,
  pickDriveFolder,
  saveJsonToDrive,
  switchGoogleAccount,
  type DriveAccount,
  type DriveFolder,
  type DriveSaveRecord,
} from '../lib/googleDrive';

export function useClassWorkFiles(
  source: SnapshotSource,
  onTeacherImportRoom: RestoreClassWork,
  onRestored: (snapshot: PendingSnapshotData) => void
) {
  const { roomId } = source;
  const [pendingSnapshot, setPendingSnapshot] = useState<PendingSnapshotData | null>(null);
  const [importMode, setImportMode] = useState<ImportRestoreMode>('replace');
  const [importError, setImportError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [driveSaveDialog, setDriveSaveDialog] = useState<{
    defaultFileName: string;
    folder: DriveFolder;
    lastSave: DriveSaveRecord | null;
  } | null>(null);
  const [driveSaveBusy, setDriveSaveBusy] = useState<'saving' | 'choosing-folder' | 'creating-folder' | null>(null);
  const [driveSaveError, setDriveSaveError] = useState<{ message: string; retrySave?: boolean } | null>(null);
  const [driveAccount, setDriveAccount] = useState<DriveAccount | null>(null);
  const [driveOpening, setDriveOpening] = useState(false);
  const [driveNotice, setDriveNotice] = useState<{ text: string; isError?: boolean } | null>(null);
  const [driveOpenError, setDriveOpenError] = useState<string | null>(null);
  const driveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (driveNoticeTimerRef.current) clearTimeout(driveNoticeTimerRef.current);
    };
  }, []);

  // Export complete Room Snapshot (.json) including main board + all breakout/individual subBoards
  const handleExportJSON = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const { json, fileName } = await buildSnapshotJson(source);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.download = fileName;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setDownloadError(null);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Could not download class work.');
    } finally {
      setIsDownloading(false);
    }
  };

  const showDriveNotice = (text: string, isError = false) => {
    setDriveNotice({ text, isError });
    if (driveNoticeTimerRef.current) clearTimeout(driveNoticeTimerRef.current);
    driveNoticeTimerRef.current = setTimeout(() => {
      setDriveNotice(null);
      driveNoticeTimerRef.current = null;
    }, 6000);
  };

  const driveErrorText = (err: any, fallback: string) =>
    err instanceof GoogleError ? friendlyGoogleError(err.code) : err?.message || fallback;

  const refreshDriveAccount = async () => {
    const account = await getDriveAccount();
    setDriveAccount(account);
    return account;
  };

  const handleSwitchDriveAccount = async () => {
    setDriveOpenError(null);
    setDriveSaveError(null);
    try {
      await switchGoogleAccount(); // calls requestToken('select_account') directly inside click
      const account = await refreshDriveAccount();
      const nextLastSave = getRoomDriveSave(roomId, account?.email);
      setDriveSaveDialog((d) =>
        d
          ? {
              ...d,
              folder: nextLastSave?.folder ?? getLastDriveFolder(account?.email),
              lastSave: nextLastSave,
            }
          : d
      );
    } catch (err: any) {
      const message = driveErrorText(err, 'Could not switch Google account.');
      if (driveSaveDialog) {
        setDriveSaveError({ message });
      } else {
        setDriveOpenError(message);
      }
    }
  };

  /** Opens the Save Room dialog in the folder this room (or any room) was last saved to. */
  const handleSaveToDrive = () => {
    setDriveNotice(null);
    if (driveNoticeTimerRef.current) {
      clearTimeout(driveNoticeTimerRef.current);
      driveNoticeTimerRef.current = null;
    }
    const lastSave = getRoomDriveSave(roomId, driveAccount?.email);
    setDriveSaveError(null);
    setDriveSaveBusy(null);
    setDriveSaveDialog({
      defaultFileName: snapshotFileName(roomId),
      folder: lastSave?.folder ?? getLastDriveFolder(driveAccount?.email),
      lastSave,
    });
  };

  const handleDriveChangeFolder = async () => {
    if (!driveSaveDialog) return;
    setDriveSaveError(null);
    setDriveSaveBusy('choosing-folder');
    try {
      const folder = await pickDriveFolder(driveSaveDialog.folder); // signs in first, inside the click
      void refreshDriveAccount();
      if (folder) setDriveSaveDialog((d) => (d ? { ...d, folder } : d));
    } catch (err: any) {
      setDriveSaveError({ message: driveErrorText(err, 'Could not open Google Drive.') });
    } finally {
      setDriveSaveBusy(null);
    }
  };

  const handleDriveCreateFolder = async (folderName: string): Promise<boolean> => {
    if (!driveSaveDialog) return false;
    setDriveSaveError(null);
    setDriveSaveBusy('creating-folder');
    try {
      const created = await createDriveFolder(folderName, driveSaveDialog.folder);
      void refreshDriveAccount();
      setDriveSaveDialog((d) => (d ? { ...d, folder: created } : d));
      return true;
    } catch (err: any) {
      setDriveSaveError({ message: driveErrorText(err, 'Could not create Google Drive folder.') });
      return false;
    } finally {
      setDriveSaveBusy(null);
    }
  };

  const handleDriveSaveConfirm = async (fileName: string) => {
    if (!driveSaveDialog) return;
    const { folder } = driveSaveDialog;
    setDriveSaveError(null);
    setDriveSaveBusy('saving');
    try {
      await getAccessToken(); // call first inside click handler so popup is not blocked
      const { json } = await buildSnapshotJson(source);
      const saved = await saveJsonToDrive(roomId, fileName, folder, json);
      void refreshDriveAccount();
      setDriveSaveDialog(null);
      showDriveNotice(`Saved ${saved.fileName} to ${saved.folder.name}`);
    } catch (err: any) {
      setDriveSaveError({ message: driveErrorText(err, 'Could not save to Google Drive.'), retrySave: true });
    } finally {
      setDriveSaveBusy(null);
    }
  };

  const handleOpenFromDrive = async () => {
    setDriveOpenError(null);
    setDriveOpening(true);
    try {
      const doc = await pickDriveFile('snapshot');
      void refreshDriveAccount();
      if (!doc) return;
      const file = await downloadDriveFile(doc);
      openSnapshotText(doc.name, await file.text());
    } catch (err: any) {
      setDriveOpenError(
        err instanceof GoogleError
          ? friendlyGoogleError(err.code)
          : err?.message || 'Could not open snapshot from Drive.'
      );
    } finally {
      setDriveOpening(false);
    }
  };

  const openSnapshotText = (fileName: string, text: string) => {
    const { pending, error } = parseSnapshotText(fileName, text, roomId);
    setRestoreNotice(null);
    setImportError(error);
    setPendingSnapshot(pending);
    if (!error) setImportMode('replace');
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      openSnapshotText(file.name, String(reader.result || ''));
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleConfirmImport = async () => {
    if (!pendingSnapshot || importError || isImporting) return;
    // File and preview metadata stay in the dialog. The server receives the parsed class work.
    const { fileName, roomId, exportedAt, exportedBy, ...classWork } = pendingSnapshot;
    setIsImporting(true);
    try {
      const result = await onTeacherImportRoom(classWork, importMode);
      if (result.connectionError) {
        setRestoreNotice(result.error || 'Check the board after reconnecting before you retry.');
        return;
      }
      if (!result.ok) {
        setImportError(result.error || 'Failed to restore room snapshot.');
        return;
      }
      setPendingSnapshot(null);
      setImportError(null);
      onRestored(pendingSnapshot);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to restore room snapshot.');
    } finally {
      setIsImporting(false);
    }
  };

  return {
    handleFileChange,
    handleExportJSON,
    handleOpenFromDrive,
    handleSaveToDrive,
    handleSwitchDriveAccount,
    refreshDriveAccount,
    driveOpening,
    driveAccount,
    driveOpenError,
    driveNotice,
    isDownloading,
    downloadError,
    dismissDownloadError: () => setDownloadError(null),
    restoreNotice,
    reviewRestore: () => setRestoreNotice(null),
    discardRestore: () => {
      setRestoreNotice(null);
      setPendingSnapshot(null);
    },
    saveDialog: driveSaveDialog && {
      ...driveSaveDialog,
      accountEmail: driveAccount?.email,
      busy: driveSaveBusy,
      error: driveSaveError?.message,
      retrySave: driveSaveError?.retrySave,
      onChangeFolder: handleDriveChangeFolder,
      onCreateFolder: handleDriveCreateFolder,
      onSwitchAccount: handleSwitchDriveAccount,
      onSave: handleDriveSaveConfirm,
      onCancel: () => {
        if (!driveSaveBusy) setDriveSaveDialog(null);
      },
    },
    restoreDialog: !restoreNotice &&
      pendingSnapshot && {
        roomId,
        pendingSnapshot,
        importError,
        importMode,
        setImportMode,
        isImporting,
        onConfirmImport: handleConfirmImport,
        onCancel: () => {
          setPendingSnapshot(null);
          setImportError(null);
        },
      },
  };
}
