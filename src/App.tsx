import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import Fuse from "fuse.js";
import React, { useEffect, useState } from "react";
import "./App.css";
import { evaluateMathExpression, formatMathResult, looksLikeMathExpression } from "./mathEval";

interface AppItem {
  name: string;
  target: string;
  description?: string;
  isCustom?: boolean;
  icon?: string;
  queryMode?: boolean; // このコマンド名をキーワードにしたクエリ検索(例: "g react")を許可するか
}

const ADD_COMMAND: AppItem = {
  name: "Add command",
  target: "cmd:add",
  description: "Create a new custom command"
};

interface AppSettings {
  backgroundColor: string;
  opacity: number;
  textColor: string;
  labelColor: string;
  highlightColor: string;
  alertColor: string;
  successColor: string;
  errorColor: string;
  hotkey: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  backgroundColor: "#000000",
  opacity: 0.95,
  textColor: "#dddddd",
  labelColor: "#777777",
  highlightColor: "#ffffff",
  alertColor: "#ff5c5c",
  successColor: "#06bc5e",
  errorColor: "#ca4444",
  hotkey: "Alt+Space",
};

// /settings の画面に並べる設定項目リスト
const SETTINGS_STEPS: { key: keyof AppSettings; label: string; kind: 'color' | 'opacity' | 'hotkey' }[] = [
  { key: 'backgroundColor', label: 'Background color (#rrggbb)', kind: 'color' },
  { key: 'opacity', label: 'Window opacity (0.1-1.0)', kind: 'opacity' },
  { key: 'textColor', label: 'Text color (#rrggbb)', kind: 'color' },
  { key: 'labelColor', label: 'Label/prompt text color (#rrggbb)', kind: 'color' },
  { key: 'highlightColor', label: 'Selected suggestion highlight color (#rrggbb)', kind: 'color' },
  { key: 'alertColor', label: 'Alert text color (#rrggbb)', kind: 'color' },
  { key: 'successColor', label: 'Success popup color (#rrggbb)', kind: 'color' },
  { key: 'errorColor', label: 'Error popup color (#rrggbb)', kind: 'color' },
  { key: 'hotkey', label: 'Hotkey (e.g. Alt+Space)', kind: 'hotkey' },
];

// #rrggbb と 0-1のopacityから rgba(...) 文字列を作る（CSS変数にまとめて渡すため）
function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return `rgba(0, 0, 0, ${alpha})`;
  const r = parseInt(match[1].slice(0, 2), 16);
  const g = parseInt(match[1].slice(2, 4), 16);
  const b = parseInt(match[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// URLのホスト名から "www." とTLDを除いた主要部分を取り出す（例: https://www.google.com/... -> "google"）
function getUrlKeyword(urlString: string): string | null {
  try {
    const hostname = new URL(urlString).hostname.replace(/^www\./, "");
    return hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

interface QueryEngine {
  keyword: string; // 検索窓で最初に打つトリガー文字列 (例: "g")
  label: string;   // プロンプトの[]内に出すラベル (例: "google")
  urlTemplate: string; // 検索語をここに差し込んで開くURL（{query}があればそこへ、無ければ末尾にq=として付加）
}

// カスタムコマンドが1つも登録されていない状態でも、最低限すぐ試せるように用意した既定のクエリ検索
const DEFAULT_QUERY_ENGINES: Record<string, string> = {
  g: "https://www.google.com/search?q={query}",
};

// クエリ検索のURLを組み立てる。{query}が書かれていればそこへ差し込み、
// 無ければ「target = 普通に開くURL、queryModeで検索対応」というシームレスな設定を実現するため
// 末尾に ?q= (または &q=) として自動付加する
function buildQueryUrl(template: string, query: string): string {
  const trimmed = query.trim();
  // 引数なしの場合：{query}プレースホルダーは取り除いて素のURLのまま開く
  // （queryModeの自動付加パターンならtemplateにそもそも{query}が無いので、そのまま無加工で開かれる）
  if (!trimmed) return template.replace("{query}", "");

  const encoded = encodeURIComponent(trimmed);
  if (template.includes("{query}")) {
    return template.replace("{query}", encoded);
  }
  const separator = template.includes("?") ? "&" : "?";
  return `${template}${separator}q=${encoded}`;
}

// システムコマンド。他のコマンドと衝突しないよう "/" で始める専用の記法にする
// (sleep/lock/hibernate/explorerは確認不要でEnter即実行、それ以外はy/n確認ステップに入る)
type SlashCommand = 'shutdown' | 'restart' | 'logoff' | 'emptytrash';

const SLASH_CONFIRM_MESSAGES: Record<SlashCommand, string> = {
  shutdown: 'Shut down this PC now',
  restart: 'Restart this PC now',
  logoff: 'Sign out of this PC now',
  emptytrash: 'Empty the Recycle Bin now',
};

// "/" だけ打った時点で全件、"/sh"のように続けて打つと絞り込まれるサジェスト用の候補
const SLASH_COMMAND_ITEMS: AppItem[] = [
  { name: "/sleep", target: "cmd:slash:sleep", description: "Put this PC to sleep" },
  { name: "/lock", target: "cmd:slash:lock", description: "Lock this PC" },
  { name: "/hibernate", target: "cmd:slash:hibernate", description: "Hibernate this PC" },
  { name: "/explorer", target: "cmd:slash:explorer", description: "Open File Explorer" },
  { name: "/shutdown", target: "cmd:slash:shutdown", description: "Shut down this PC" },
  { name: "/restart", target: "cmd:slash:restart", description: "Restart this PC" },
  { name: "/logoff", target: "cmd:slash:logoff", description: "Sign out of this PC" },
  { name: "/emptytrash", target: "cmd:slash:emptytrash", description: "Empty the Recycle Bin" },
  { name: "/settings", target: "cmd:settings", description: "Open settings" },
];

// add/edit commandを会話形式で1問ずつ聞いていく際の質問リスト
const ADD_COMMAND_STEPS: { key: 'name' | 'target' | 'description' | 'queryMode'; label: string; required: boolean; type: 'text' | 'yn' }[] = [
  { key: 'name', label: 'Name', required: true, type: 'text' },
  { key: 'target', label: 'Target (URL or Path)', required: true, type: 'text' },
  { key: 'description', label: 'Description (optional)', required: false, type: 'text' },
  { key: 'queryMode', label: 'Enable query mode? (y/n)', required: false, type: 'yn' },
];

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AppItem[]>([]);
  const [appList, setAppList] = useState<AppItem[]>([]);
  const [openWindows, setOpenWindows] = useState<AppItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<'search' | 'add-command' | 'settings'>('search');
  const [newApp, setNewApp] = useState({ name: '', target: '', description: '', queryMode: '' });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Record<keyof AppSettings, string>>({
    backgroundColor: '', opacity: '', textColor: '', labelColor: '', highlightColor: '', alertColor: '', successColor: '', errorColor: '', hotkey: ''
  });
  const [settingsStep, setSettingsStep] = useState(0); // 今フォーカスしているフィールドのインデックス（SETTINGS_STEPS.length-1に達すると確認行が現れる）
  const [settingsFieldErrors, setSettingsFieldErrors] = useState<Partial<Record<keyof AppSettings, string>>>({});
  const [settingsConfirmInput, setSettingsConfirmInput] = useState('');
  const [settingsConfirmError, setSettingsConfirmError] = useState(false);
  const settingsInputRefs = React.useRef<(HTMLInputElement | null)[]>([]);
  const settingsConfirmInputRef = React.useRef<HTMLInputElement | null>(null);
  const errorTimeoutRef = React.useRef<number | null>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingOldName, setEditingOldName] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const successTimeoutRef = React.useRef<number | null>(null);
  const [itemToDelete, setItemToDelete] = useState<AppItem | null>(null);
  const [pendingSlashCommand, setPendingSlashCommand] = useState<SlashCommand | null>(null); // /shutdown, /restart の y/n確認中
  const [slashConfirmInput, setSlashConfirmInput] = useState('');
  const [slashConfirmError, setSlashConfirmError] = useState(false);
  const [cmdStep, setCmdStep] = useState(0); // add/edit commandの会話が今どの質問にいるか（ADD_COMMAND_STEPS.lengthに達したら確認(y/n)ステップ）
  const [stepError, setStepError] = useState(false); // 必須項目が未入力のままEnterされた
  const [nameConflict, setNameConflict] = useState(false); // Nameが既存のカスタムコマンドと重複している
  const [confirmInput, setConfirmInput] = useState('');
  const [confirmError, setConfirmError] = useState(false);
  const [queryEngine, setQueryEngine] = useState<QueryEngine | null>(null); // "g react" のようなクエリ検索モードに入っているか
  const [queryArg, setQueryArg] = useState(''); // クエリ検索モード中の、キーワードより後ろの入力
  const [iconMap, setIconMap] = useState<Record<string, string>>({});
  const pendingIconsRef = React.useRef<Set<string>>(new Set());
  const [usageMap, setUsageMap] = useState<Record<string, { count: number; last_used: number }>>({});

  // 起動回数が多い/最近使ったものほど高いスコアになる（フリーセンシー）
  const usageScore = (target: string) => {
    const entry = usageMap[target];
    if (!entry) return 0;
    const daysSinceUsed = (Date.now() / 1000 - entry.last_used) / 86400;
    return entry.count / (1 + daysSinceUsed);
  };

  // 画面に表示されているアイテムの分だけ、必要になったタイミングでアイコンを取りに行く
  const ensureIcon = async (target: string) => {
    if (iconMap[target] || pendingIconsRef.current.has(target)) return;
    pendingIconsRef.current.add(target);
    try {
      const icon = await invoke<string | null>("get_icon", { target });
      if (icon) {
        setIconMap(prev => ({ ...prev, [target]: icon }));
      }
    } catch (e) {
      console.warn("Failed to load icon:", target, e);
    } finally {
      pendingIconsRef.current.delete(target);
    }
  };

  // 検索結果として実際に表示されている分（最大20件）だけアイコンを取得する
  useEffect(() => {
    results.slice(0, 20).forEach(app => {
      if (!app.icon) {
        ensureIcon(app.target);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // useEffectを使って、selectedIndexが変わるたびにスクロールさせる
  useEffect(() => {
    if (listRef.current) {
      const activeItem = listRef.current.children[selectedIndex] as HTMLElement;
      if (activeItem) {
        activeItem.scrollIntoView({
          behavior: "smooth", // スッとスクロールさせる
          block: "nearest"    // 画面内に収まるように最低限だけスクロール
        });
      }
    }
  }, [selectedIndex]); // selectedIndexが変わるたびに実行

  const showError = (message: string) => {
    setErrorMsg(message);

    // 前のタイマーが残っていたらリセットする
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }

    // 新しいタイマーをセット
    errorTimeoutRef.current = window.setTimeout(() => {
      setErrorMsg(null);
    }, 3000);
  };

  const showSuccess = (message: string) => {
    setSuccessMsg(message);

    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
    }

    successTimeoutRef.current = window.setTimeout(() => {
      setSuccessMsg(null);
    }, 3000);
  };

  // add/edit commandの会話状態を初期化して検索画面に戻る（保存後・キャンセル共通）
  const resetCommandFlow = () => {
    setMode('search');
    setNewApp({ name: '', target: '', description: '', queryMode: '' });
    setEditingOldName(null);
    setCmdStep(0);
    setStepError(false);
    setNameConflict(false);
    setConfirmInput('');
    setConfirmError(false);
  };

  // /settings の状態を初期化して検索画面に戻る（保存後・キャンセル共通）
  const resetSettingsFlow = () => {
    setMode('search');
    setSettingsStep(0);
    setSettingsFieldErrors({});
    setSettingsConfirmInput('');
    setSettingsConfirmError(false);
  };

  const enterSettingsMode = () => {
    setSettingsDraft({
      backgroundColor: settings.backgroundColor,
      opacity: String(settings.opacity),
      textColor: settings.textColor,
      labelColor: settings.labelColor,
      highlightColor: settings.highlightColor,
      alertColor: settings.alertColor,
      successColor: settings.successColor,
      errorColor: settings.errorColor,
      hotkey: settings.hotkey,
    });
    setSettingsStep(0);
    setSettingsFieldErrors({});
    setSettingsConfirmInput('');
    setSettingsConfirmError(false);
    setMode('settings');
    setQuery("");
    setResults([]);
  };

  // 色・opacityの同期バリデーション（hotkeyは別途非同期で検証する）
  const validateSettingsField = (kind: 'color' | 'opacity' | 'hotkey', value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return "necessary";
    if (kind === 'color' && !/^#[0-9a-fA-F]{6}$/.test(trimmed)) return "expected #rrggbb";
    if (kind === 'opacity') {
      const n = Number(trimmed);
      if (Number.isNaN(n) || n < 0.1 || n > 1.0) return "expected 0.1-1.0";
    }
    return null;
  };

  // ホットキーが実際にOSへ登録できる形式か試す（登録できたらすぐ解除する「ドライラン」）。
  // "Alt+Control"のように修飾キーだけで実キーが無い等、無効な組み合わせを保存前に弾くため
  const validateHotkey = async (value: string): Promise<string | null> => {
    const trimmed = value.trim();
    if (!trimmed) return "necessary";
    if (trimmed === settings.hotkey) return null; // 現在登録中のものと同じなら試す必要なし
    try {
      await register(trimmed, () => {});
      await unregister(trimmed);
      return null;
    } catch {
      return "invalid hotkey (or already used by another app)";
    }
  };

  // 指定インデックスのフィールド（末尾を超えたら確認欄）にフォーカスを移す
  const focusSettingsField = (index: number) => {
    if (index < 0) return;
    if (index >= SETTINGS_STEPS.length) {
      settingsConfirmInputRef.current?.focus();
      return;
    }
    settingsInputRefs.current[index]?.focus();
  };

  const handleSettingsFieldChange = (index: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const step = SETTINGS_STEPS[index];
    const value = e.target.value;
    setSettingsDraft(prev => ({ ...prev, [step.key]: value }));
    // hotkeyは打つたびに登録テストするのは重いので、変更中はエラー表示だけ消しておき、blur時に検証する
    const error = step.kind === 'hotkey' ? null : validateSettingsField(step.kind, value);
    setSettingsFieldErrors(prev => ({ ...prev, [step.key]: error ?? undefined }));
  };

  const handleSettingsFieldFocus = (index: number) => () => {
    setSettingsStep(index);
  };

  const handleSettingsFieldBlur = (index: number) => async () => {
    const step = SETTINGS_STEPS[index];
    if (step.kind !== 'hotkey') return;
    const error = await validateHotkey(settingsDraft[step.key]);
    setSettingsFieldErrors(prev => ({ ...prev, [step.key]: error ?? undefined }));
  };

  const handleSettingsFieldKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      focusSettingsField(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusSettingsField(index - 1);
    }
    // Tab / Shift+Tab はブラウザ標準のフォーカス移動に任せる（ここでは何もしない）
  };

  const buildSettingsFromDraft = (): AppSettings => ({
    backgroundColor: settingsDraft.backgroundColor.trim(),
    opacity: Number(settingsDraft.opacity.trim()),
    textColor: settingsDraft.textColor.trim(),
    labelColor: settingsDraft.labelColor.trim(),
    highlightColor: settingsDraft.highlightColor.trim(),
    alertColor: settingsDraft.alertColor.trim(),
    successColor: settingsDraft.successColor.trim(),
    errorColor: settingsDraft.errorColor.trim(),
    hotkey: settingsDraft.hotkey.trim(),
  });

  const handleSettingsConfirmKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusSettingsField(SETTINGS_STEPS.length - 1);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();

    const answer = settingsConfirmInput.trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      // 保存前に全項目をあらためて検証する
      const errors: Partial<Record<keyof AppSettings, string>> = {};
      for (const step of SETTINGS_STEPS) {
        const value = settingsDraft[step.key];
        const error = step.kind === 'hotkey' ? await validateHotkey(value) : validateSettingsField(step.kind, value);
        if (error) errors[step.key] = error;
      }
      if (Object.keys(errors).length > 0) {
        setSettingsFieldErrors(errors);
        const firstErrorIndex = SETTINGS_STEPS.findIndex(s => errors[s.key]);
        if (firstErrorIndex >= 0) focusSettingsField(firstErrorIndex);
        return;
      }

      const newSettings = buildSettingsFromDraft();
      try {
        await invoke("save_settings", { settings: newSettings });
        setSettings(newSettings);
        showSuccess("Settings saved!");
        resetSettingsFlow();
      } catch (err) {
        showError("Failed to save settings");
      }
    } else if (answer === "n" || answer === "no") {
      resetSettingsFlow();
    } else {
      setSettingsConfirmError(true);
      setSettingsConfirmInput('');
    }
  };

  // Icon
  const getBadge = (target: string) => {
    if (target === "cmd:add") return <span className="badge badge-cmd">CMD</span>;
    if (target === "cmd:settings") return <span className="badge badge-cmd">CMD</span>;
    if (target.startsWith("cmd:slash:")) return <span className="badge badge-sys">SYS</span>;
    if (target.startsWith("http")) return <span className="badge badge-url">URL</span>;
    if (target.startsWith("HWND:")) return <span className="badge badge-win">WIN</span>;
    return <span className="badge badge-app">APP</span>;  // アプリやコマンド
  };

  // 確認なしで即実行するシステムコマンド。それ以外(shutdown/restart/logoff/emptytrash)はy/n確認へ
  const DIRECT_SLASH_ACTIONS = ["sleep", "lock", "hibernate", "explorer"];

  const runSlashAction = async (action: string) => {
    if (DIRECT_SLASH_ACTIONS.includes(action)) {
      try {
        await invoke("run_system_command", { action });
      } catch (err) {
        showError(`Failed to run /${action}`);
      }
      const appWindow = getCurrentWindow();
      await appWindow.hide();
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      return;
    }
    if (action in SLASH_CONFIRM_MESSAGES) {
      setPendingSlashCommand(action as SlashCommand);
      setSlashConfirmInput('');
      setSlashConfirmError(false);
      setQuery(`/${action}`);
      setResults([]);
      setSelectedIndex(0);
    }
  };

  // Launch
  const launchApp = async (app: AppItem) => {
    if (app.target === "cmd:settings") {
      enterSettingsMode();
      return;
    }
    if (app.target.startsWith("cmd:slash:")) {
      await runSlashAction(app.target.slice("cmd:slash:".length));
      return;
    }

    let finalTarget = app.target;

    if (finalTarget.startsWith("http")) {
      const keyword = getUrlKeyword(finalTarget);
      if (keyword) {
        const matchingWindow = openWindows.find(w =>
          w.name.toLowerCase().includes(keyword.toLowerCase())
        );

        if (matchingWindow) {
          finalTarget = matchingWindow.target;
        }
      }
    }

    try {
      await invoke("open_target", { target: finalTarget });

      // HWND(開いているウィンドウ)はセッションごとに変わり次回以降マッチしないので記録しない
      if (!app.target.startsWith("HWND:")) {
        invoke("record_usage", { target: app.target }).catch(e =>
          console.warn("Failed to record usage:", e)
        );
      }

      // 成功したらウィンドウを隠してリセットする
      const appWindow = getCurrentWindow();
      await appWindow.hide();
      setQuery("");
      setResults([]);
      setSelectedIndex(0);

    } catch (error) {
      showError("Invalid command!");
    }
  };

  const fetchConfig = React.useCallback(async () => {
    try {
      let windows: AppItem[] = [];
      try {
        windows = await invoke("get_open_windows");
        setOpenWindows(windows);
      } catch (e) {
        console.warn("Failed to get windows:", e);
      }

      let customApps: AppItem[] = [];
      try {
        const jsonString: string = await invoke("load_config");
        const data = JSON.parse(jsonString);
        if (data.custom_apps) {
          customApps = data.custom_apps.map((app: AppItem) => ({
            ...app,
            isCustom: true
          }));
        }
        setUsageMap(data.usage || {});
      } catch (e) {
        console.warn("Failed to load config:", e);
      }

      try {
        const settingsJson: string = await invoke("load_settings");
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(settingsJson) });
      } catch (e) {
        console.warn("Failed to load settings:", e);
      }

      let scannedApps: AppItem[] = [];
      try {
        scannedApps = await invoke("scan_apps");
      } catch (e) {
        console.warn("Failed to load config:", e);
      }

      setAppList([...windows, ...customApps, ...scannedApps]);
    } catch (error) {
      console.error("Fetch error: ", error);
      showError("Failed to initialize launcher");
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // settingsの色・透明度をCSSカスタムプロパティに反映する
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--wm-bg-rgba', hexToRgba(settings.backgroundColor, settings.opacity));
    root.setProperty('--wm-text-color', settings.textColor);
    root.setProperty('--wm-label-color', settings.labelColor);
    root.setProperty('--wm-highlight-color', settings.highlightColor);
    root.setProperty('--wm-alert-color', settings.alertColor);
    root.setProperty('--wm-success-color', hexToRgba(settings.successColor, 0.95));
    root.setProperty('--wm-error-color', hexToRgba(settings.errorColor, 0.95));
  }, [settings]);

  // ホットキーの登録。/settingsで変更されたら(settings.hotkeyが変わったら)古いものを解除して登録し直す。
  // 登録に失敗した場合（無効な組み合わせ・他アプリに取られている等）は、
  // 二度と起動できなくならないよう既定のホットキーへ自動フォールバックする
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const hotkey = settings.hotkey || DEFAULT_SETTINGS.hotkey;
    let registeredHotkey = hotkey;

    const onHotkey = async (event: { state: string }) => {
      if (event.state === "Pressed") {
        const isVisible = await appWindow.isVisible();
        if (isVisible) {
          await appWindow.hide();
        } else {
          // 開くたびに最新のウィンドウ情報を取得し直す
          fetchConfig();
          await appWindow.show();
          await appWindow.setFocus();
          setQuery("");
          setResults([]);
          setSelectedIndex(0);
        }
      }
    };

    const setupShortcut = async () => {
      try {
        await register(hotkey, onHotkey);
      } catch (error) {
        console.error("Failed to register shortcut:", error);
        if (hotkey === DEFAULT_SETTINGS.hotkey) return;
        showError(`Invalid hotkey "${hotkey}" — falling back to ${DEFAULT_SETTINGS.hotkey}`);
        try {
          await register(DEFAULT_SETTINGS.hotkey, onHotkey);
          registeredHotkey = DEFAULT_SETTINGS.hotkey;
        } catch (fallbackError) {
          console.error("Failed to register fallback shortcut:", fallbackError);
        }
      }
    };

    setupShortcut();
    return () => {
      unregister(registeredHotkey).catch(console.error);
    }
  }, [settings.hotkey, fetchConfig]);

  // 画面全体でのキーボード操作を監視する
  React.useEffect(() => {
    const appWindow = getCurrentWindow();

    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      const isCancelKey = e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "c");

      if (mode === 'add-command') {
        // Add/Edit Command画面にいる時は、EscかCtrl+Cで検索画面に戻るだけ（アプリは閉じない）
        if (isCancelKey) {
          e.preventDefault();
          e.stopPropagation();
          resetCommandFlow();
        }
      } else if (mode === 'settings') {
        // Settings画面も同様
        if (isCancelKey) {
          e.preventDefault();
          e.stopPropagation();
          resetSettingsFlow();
        }
      } else if (e.key === "Escape") {
        if (queryEngine) {
          // クエリ検索モード中は、Escでアプリを閉じずにモードだけ抜ける
          exitQueryEngine();
        } else if (pendingSlashCommand) {
          // /shutdown, /restart の確認中も同様にモードだけ抜ける
          exitSlashCommand();
        } else {
          // それ以外の通常検索では何もしない（＝そのまま上位に伝わってアプリが閉じる）
          await appWindow.hide();
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [mode, queryEngine, pendingSlashCommand]);

  // 入力された最初の単語が、{query}プレースホルダーを持つクエリ検索のキーワードかどうかを調べる
  // （登録したカスタムコマンドを優先し、無ければDEFAULT_QUERY_ENGINESにフォールバック）
  const findQueryEngine = (keyword: string): QueryEngine | null => {
    const lower = keyword.toLowerCase();

    const customMatch = appList.find(app =>
      app.isCustom && app.name.toLowerCase() === lower && (app.target.includes("{query}") || app.queryMode)
    );
    const urlTemplate = customMatch?.target ?? DEFAULT_QUERY_ENGINES[lower];
    if (!urlTemplate) return null;

    const label = getUrlKeyword(urlTemplate.split("{query}")[0]) ?? keyword;
    return { keyword, label, urlTemplate };
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // "/" で始めたら専用の名前空間として、システムコマンドだけを候補に出す
    if (value.startsWith('/')) {
      setQuery(value);
      setSelectedIndex(0);
      const lower = value.toLowerCase();
      setResults(SLASH_COMMAND_ITEMS.filter(item => item.name.toLowerCase().startsWith(lower)));
      return;
    }

    // 「キーワード + 半角スペース」の形になったら、SSHで別サーバに入るようにクエリ検索モードへ切り替える
    if (!queryEngine) {
      const spaceIndex = value.indexOf(' ');
      if (spaceIndex > 0) {
        const engine = findQueryEngine(value.slice(0, spaceIndex));
        if (engine) {
          setQueryEngine(engine);
          setQueryArg(value.slice(spaceIndex + 1));
          setQuery(value);
          setResults([]);
          setSelectedIndex(0);
          return;
        }
      }
    }

    setQuery(value);
    setSelectedIndex(0); // 検索文字が変わったら選択位置を一番上に戻す

    if (value) {
      const fuse = new Fuse(appList, {
        keys: ["name", "target"], // 名前だけでなく、URLやパス（target）も検索対象にする
        threshold: 0.4, // 0.0(完全一致)～1.0(なんでもマッチ)
      });

      // Search
      const fuseResult = fuse.search(value);
      // Set item
      const filteredResult = fuseResult.map(res => res.item);

      filteredResult.sort((a, b) => {
        const isAHwnd = a.target.startsWith("HWND:");
        const isBHwnd = b.target.startsWith("HWND:");

        if (isAHwnd && !isBHwnd) return -1; // aがHWNDなら前にする
        if (!isAHwnd && isBHwnd) return 1;  // bがHWNDなら前にする

        // よく使う/最近使ったものを優先する（使用履歴がなければ0点でFuse.jsの順位のまま）
        const scoreDiff = usageScore(b.target) - usageScore(a.target);
        if (scoreDiff !== 0) return scoreDiff;

        return 0; // 両方HWND、あるいは両方違う場合は、Fuse.jsの元の順位（スコア）を維持
      });

      // Merge "add command"
      if ("add command".includes(value.toLowerCase())) {
        setResults([ADD_COMMAND, ...filteredResult]);
      } else {
        setResults(filteredResult);
      }
    } else {
      setResults([]);
    }
    console.log(appList);
  };

  // クエリ検索モード中に元のキーワード入力に戻る（Backspace/Escでの離脱と共通）
  const exitQueryEngine = () => {
    setQuery(queryEngine?.keyword ?? '');
    setQueryEngine(null);
    setQueryArg('');
  };

  const handleQueryArgChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQueryArg(e.target.value);
  };

  const handleQueryArgKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && queryArg === '') {
      // 入力欄が空の状態でさらにBackspace：キーワード入力に戻る
      e.preventDefault();
      exitQueryEngine();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (!queryEngine) return;
      // 引数が空でもエラーにはせず、素のURLをそのまま開く
      const trimmedArg = queryArg.trim();
      const target = buildQueryUrl(queryEngine.urlTemplate, trimmedArg);
      const name = trimmedArg ? `${queryEngine.label}: ${trimmedArg}` : queryEngine.label;
      setQueryEngine(null);
      setQueryArg('');
      await launchApp({ name, target });
    }
  };

  // /shutdown, /restart の確認ステップから抜けて、元のコマンド文字列の編集に戻る
  const exitSlashCommand = () => {
    setQuery(pendingSlashCommand ? `/${pendingSlashCommand}` : '');
    setPendingSlashCommand(null);
    setSlashConfirmInput('');
    setSlashConfirmError(false);
  };

  const handleSlashConfirmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSlashConfirmInput(e.target.value);
    setSlashConfirmError(false);
  };

  const handleSlashConfirmKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && slashConfirmInput === '') {
      e.preventDefault();
      exitSlashCommand();
      return;
    }

    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!pendingSlashCommand) return;

    const answer = slashConfirmInput.trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      const action = pendingSlashCommand;
      setPendingSlashCommand(null);
      setSlashConfirmInput('');
      try {
        await invoke("run_system_command", { action });
        const appWindow = getCurrentWindow();
        await appWindow.hide();
        setQuery("");
        setResults([]);
        setSelectedIndex(0);
      } catch (err) {
        showError(`Failed to ${action}`);
      }
    } else if (answer === "n" || answer === "no") {
      setPendingSlashCommand(null);
      setSlashConfirmInput('');
      setSlashConfirmError(false);
      setQuery('');
    } else {
      setSlashConfirmError(true);
      setSlashConfirmInput('');
    }
  };

  // ▼ Enterキーと、上下キーの処理を統合
  const handleExecute = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const selectedItem = results[selectedIndex] || { name: query, target: query };

      // /settings : サジェストから選んでいてもタイプし切っていても設定画面へ
      if (selectedItem.target === "cmd:settings" || query.trim().toLowerCase() === "/settings") {
        enterSettingsMode();
        return;
      }

      // /sleep, /lock, /shutdown, /restart 等 : サジェストから選んでいてもタイプし切っていても同じように扱う
      const slashAction = selectedItem.target.startsWith("cmd:slash:")
        ? selectedItem.target.slice("cmd:slash:".length)
        : selectedItem.target.startsWith("/")
          ? selectedItem.target.slice(1).toLowerCase()
          : null;

      if (slashAction && (DIRECT_SLASH_ACTIONS.includes(slashAction) || slashAction in SLASH_CONFIRM_MESSAGES)) {
        await runSlashAction(slashAction);
        return;
      }

      // in-line math: 数式っぽければ計算して検索窓の中身を結果に置き換える
      if (looksLikeMathExpression(query)) {
        const rawResult = evaluateMathExpression(query);
        if (rawResult === null) {
          showError("Invalid expression");
        } else {
          setQuery(formatMathResult(rawResult));
          setResults([]);
          setSelectedIndex(0);
        }
        return;
      }

      if (selectedItem.target === "cmd:add") {
        setMode('add-command');
        setCmdStep(0);
        setStepError(false);
        setNameConflict(false);
        setConfirmInput('');
        setConfirmError(false);
        setQuery("");
        setResults([]);
        return;
      }

      // Launch
      if (results.length > 0) {
        // リストから選択されているものを起動
        await launchApp(results[selectedIndex]);
      } else if (query) {
        showError("Invalid command!");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      // 下キー：リストの最後尾でなければ1つ下へ
      setSelectedIndex(prev => (prev < results.length - 1 ? prev + 1 : prev));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // 上キー：一番上でなければ1つ上へ
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === "Tab") {
      // LinuxシェルのようなTab補完。edit/deleteボタンにフォーカスが奪われないよう必ずpreventDefaultする
      e.preventDefault();
      if (results.length === 0) return;
      const maxIndex = Math.min(results.length, 20) - 1;
      const current = results[selectedIndex];
      const displayName = (name: string) => name.replace("🪟 ", "");
      if (current && query === displayName(current.name)) {
        // 既にこの候補まで補完済みなら、次の候補へ進めて補完し直す（シェルのTabサイクルと同じ）
        const nextIndex = selectedIndex < maxIndex ? selectedIndex + 1 : 0;
        setSelectedIndex(nextIndex);
        setQuery(displayName(results[nextIndex].name));
      } else if (current) {
        // まだ補完していなければ、今選択中の候補で補完する
        setQuery(displayName(current.name));
      }
    }
  };


  const handleSaveCommand = async () => {
    if (!newApp.name || !newApp.target) {
      showError("Name and Target are required");
      return;
    }

    const queryModeEnabled = /^y/i.test(newApp.queryMode.trim());

    try {
      if (editingOldName) {
        // ▼ 編集モードの場合（Rustの edit_command を呼ぶ）
        // ※ TauriはJavaScriptのキャメルケースを自動でRustのスネークケースに変換してくれます
        await invoke("edit_command", {
          oldName: editingOldName,
          newName: newApp.name,
          newTarget: newApp.target,
          newDescription: newApp.description || null,
          newQueryMode: queryModeEnabled
        });

        // リストの該当箇所だけを新しいデータに置き換える
        setAppList(prev => prev.map(item =>
          item.name === editingOldName
            ? { name: newApp.name, target: newApp.target, description: newApp.description, isCustom: true, queryMode: queryModeEnabled }
            : item
        ));
      } else {
        // ▼ 新規追加モードの場合（元の処理）
        await invoke("save_command", {
          name: newApp.name,
          target: newApp.target,
          description: newApp.description || null,
          queryMode: queryModeEnabled
        });
        setAppList(prev => [...prev, { name: newApp.name, target: newApp.target, description: newApp.description, isCustom: true, queryMode: queryModeEnabled }]);
      }

      showSuccess(editingOldName ? "Command edited!" : "Command added!");
      resetCommandFlow();
    } catch (e) {
      showError(editingOldName ? "Failed to edit command" : "Failed to save command");
    }
  };

  // 質問中の1項目にEnter：必須項目が空ならエラー表示、埋まっていれば次の質問へ
  const handleStepKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();

    const step = ADD_COMMAND_STEPS[cmdStep];
    const value = newApp[step.key];
    if (step.required && !value.trim()) {
      setStepError(true);
      return;
    }

    // コマンド名は他のカスタムコマンドと重複できない（編集中の自分自身は除く）
    if (step.key === "name") {
      const lower = value.trim().toLowerCase();
      const isDuplicate = appList.some(app =>
        app.isCustom &&
        app.name.toLowerCase() === lower &&
        app.name.toLowerCase() !== (editingOldName ?? '').toLowerCase()
      );
      if (isDuplicate) {
        setNameConflict(true);
        return;
      }
    }

    setStepError(false);
    setNameConflict(false);
    setCmdStep(prev => prev + 1);
  };

  // 最後の質問の後：y/nで保存 or キャンセル
  const handleConfirmKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();

    const answer = confirmInput.trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      handleSaveCommand();
    } else if (answer === "n" || answer === "no") {
      resetCommandFlow();
    } else {
      setConfirmError(true);
      setConfirmInput('');
    }
  };

  const handleDelete = (e: React.MouseEvent, app: AppItem) => {
    e.stopPropagation();
    setItemToDelete(app); // アラートの代わりに、削除対象をセットして自作ポップアップを表示
  };

  const confirmDelete = async () => {
    if (!itemToDelete) return;

    try {
      await invoke("delete_command", { name: itemToDelete.name });
      setAppList(prev => prev.filter(item => item.name !== itemToDelete.name));
      showSuccess("Command deleted!");
      setSelectedIndex(0);
    } catch (e) {
      showError("Failed to delete command");
    } finally {
      setItemToDelete(null); // 削除が終わったらポップアップを閉じる
    }
  };

  const handleEdit = (e: React.MouseEvent, appToEdit: AppItem) => {
    e.stopPropagation(); // アプリ起動を止める

    // 既存のデータを入力欄（newApp）にセットする
    setNewApp({
      name: appToEdit.name,
      target: appToEdit.target,
      description: appToEdit.description || '',
      queryMode: appToEdit.queryMode ? 'y' : ''
    });

    setEditingOldName(appToEdit.name); // 変更前の名前を記憶
    setMode('add-command'); // 画面を入力モードに切り替え
    setCmdStep(0);
    setStepError(false);
    setNameConflict(false);
    setConfirmInput('');
    setConfirmError(false);
  };


  return (
    <main className="main-container">
      <div className="launcher-wrapper">
        {mode === 'search' ? (
          <>
            {queryEngine ? (
              <div className="search-bar-stack">
                <div className="search-bar-line">
                  <span className="search-prompt">[WindowsManeuver]&gt;</span>
                  <span className="search-history-text">{queryEngine.keyword}</span>
                </div>
                <div className="search-bar-line">
                  <span className="search-prompt">[{queryEngine.label}]&gt;</span>
                  <input
                    className="search-input"
                    type="text"
                    autoFocus
                    value={queryArg}
                    onChange={handleQueryArgChange}
                    onKeyDown={handleQueryArgKeyDown}
                  />
                </div>
              </div>
            ) : pendingSlashCommand ? (
              <div className="search-bar-stack">
                <div className="search-bar-line">
                  <span className="search-prompt">[WindowsManeuver]&gt;</span>
                  <span className="search-history-text">/{pendingSlashCommand}</span>
                </div>
                <div className="search-bar-line">
                  <span className="search-prompt">[Are you sure?]</span>
                  <span className="terminal-label">
                    {pendingSlashCommand === 'shutdown' ? 'Shut down this PC now' : 'Restart this PC now'} (y/n):
                  </span>
                  <input
                    className={`search-input ${slashConfirmError ? 'error' : ''}`}
                    type="text"
                    autoFocus
                    value={slashConfirmInput}
                    onChange={handleSlashConfirmChange}
                    onKeyDown={handleSlashConfirmKeyDown}
                    placeholder={slashConfirmError ? "y or n" : ""}
                  />
                </div>
              </div>
            ) : (
              <div className="search-bar-stack">
                <div className="search-bar-line">
                  <span className="search-prompt">[WindowsManeuver]&gt;</span>
                  <input
                    className="search-input"
                    type="text"
                    placeholder="Where do you wanna go?"
                    autoFocus
                    value={query}
                    onChange={handleSearch}
                    onKeyDown={handleExecute}
                  />
                </div>
              </div>
            )}

            {queryEngine || pendingSlashCommand ? null : query && results.length === 0 ? (
              <div className="empty-state">No matches for "{query}" — press Enter to try it as a command</div>
            ) : results.length > 0 && (
              <ul className="suggest-list" ref={listRef}>
                {results.slice(0, 20).map((app, index) => {
                  const icon = app.icon || iconMap[app.target];
                  return (
                  <li key={index}
                    onClick={() => launchApp(app)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`suggest-item ${index === selectedIndex ? 'selected' : 'unselected'}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {icon ? (
                        <img src={icon} alt="" className="app-icon" />
                      ) : (
                        getBadge(app.target)
                      )}
                      <span>{app.name.replace("🪟 ", "")}</span>
                    </div>
                    {app.isCustom && (
                      <div className="action-buttons">
                        <button
                          onClick={(e) => handleEdit(e, app)}
                          className="action-btn"
                          title="Edit command"
                          tabIndex={-1}
                        >
                          edit
                        </button>

                        <button
                          onClick={(e) => handleDelete(e, app)}
                          className="action-btn"
                          title="Delete command"
                          tabIndex={-1}
                        >
                          delete
                        </button>
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : mode === 'add-command' ? (
          <div className="add-command-container">
            <div className="terminal-line">
              <span className="search-prompt">[WindowsManeuver]&gt;</span> {editingOldName ? "edit command" : "add command"}
            </div>

            {ADD_COMMAND_STEPS.slice(0, cmdStep).map(step => (
              <div className="terminal-line" key={step.key}>
                <span className="terminal-label">{step.label}:</span>{" "}
                <span className="terminal-answer">
                  {step.type === 'yn'
                    ? (/^y/i.test(newApp[step.key]) ? "y" : "n")
                    : (newApp[step.key] || (!step.required ? "(none)" : ""))}
                </span>
              </div>
            ))}

            {cmdStep < ADD_COMMAND_STEPS.length ? (
              <>
                <div className="terminal-line">
                  <span className="terminal-label">{ADD_COMMAND_STEPS[cmdStep].label}:</span>
                  <input
                    className={`terminal-input ${stepError || nameConflict ? 'error' : ''}`}
                    value={newApp[ADD_COMMAND_STEPS[cmdStep].key]}
                    onChange={e => {
                      setNewApp({ ...newApp, [ADD_COMMAND_STEPS[cmdStep].key]: e.target.value });
                      setStepError(false);
                      setNameConflict(false);
                    }}
                    onKeyDown={handleStepKeyDown}
                    placeholder={stepError ? "necessary" : ""}
                    autoFocus
                  />
                </div>
                {nameConflict && (
                  <div className="terminal-error-text">This name is already in use</div>
                )}
              </>
            ) : (
              <div className="terminal-line">
                <span className="terminal-label">Save this command? (y/n):</span>
                <input
                  className={`terminal-input ${confirmError ? 'error' : ''}`}
                  value={confirmInput}
                  onChange={e => {
                    setConfirmInput(e.target.value);
                    setConfirmError(false);
                  }}
                  onKeyDown={handleConfirmKeyDown}
                  placeholder={confirmError ? "y or n" : ""}
                  autoFocus
                />
              </div>
            )}

            <div className="terminal-hint">Esc or Ctrl+C to cancel and return to the home window</div>
          </div>
        ) : (
          <div className="add-command-container">
            <div className="terminal-line">
              <span className="search-prompt">[WindowsManeuver]&gt;</span> settings
            </div>

            <div className="wizard-scroll-area">
              {SETTINGS_STEPS.map((step, index) => {
                const error = settingsFieldErrors[step.key];
                const value = settingsDraft[step.key];
                const isColor = step.kind === 'color' && /^#[0-9a-fA-F]{6}$/.test(value);
                return (
                  <React.Fragment key={step.key}>
                    <div className="terminal-line">
                      <span className="terminal-label">{step.label}:</span>
                      <input
                        ref={el => { settingsInputRefs.current[index] = el; }}
                        className={`terminal-input ${error ? 'error' : ''}`}
                        value={value}
                        onChange={handleSettingsFieldChange(index)}
                        onKeyDown={handleSettingsFieldKeyDown(index)}
                        onFocus={handleSettingsFieldFocus(index)}
                        onBlur={handleSettingsFieldBlur(index)}
                        autoFocus={index === 0}
                      />
                      {isColor && (
                        <span className="settings-swatch" style={{ backgroundColor: value }} />
                      )}
                    </div>
                    {error && <div className="terminal-error-text">{error}</div>}
                  </React.Fragment>
                );
              })}

              {settingsStep >= SETTINGS_STEPS.length - 1 && (
                <div className="terminal-line">
                  <span className="terminal-label">Save these settings? (y/n):</span>
                  <input
                    ref={settingsConfirmInputRef}
                    className={`terminal-input ${settingsConfirmError ? 'error' : ''}`}
                    value={settingsConfirmInput}
                    onChange={e => {
                      setSettingsConfirmInput(e.target.value);
                      setSettingsConfirmError(false);
                    }}
                    onKeyDown={handleSettingsConfirmKeyDown}
                    onFocus={() => setSettingsStep(SETTINGS_STEPS.length)}
                    placeholder={settingsConfirmError ? "y or n" : ""}
                  />
                </div>
              )}
            </div>

            <div className="terminal-hint">↑/↓ or Tab/Shift+Tab to move between fields · Esc or Ctrl+C to cancel and return to the home window</div>
          </div>
        )}
      </div>
      {errorMsg && <div className="error-popup">✖  {errorMsg}</div>}
      {successMsg && <div className="success-popup">✔  {successMsg}</div>}
      {itemToDelete && (
        <div className="confirm-overlay">
          <div className="confirm-box">
            <p className="confirm-title">Are you sure?</p>
            <p className="confirm-detail">
              {itemToDelete.name}  <span>{itemToDelete.target}</span>
            </p>
            <div className="button-group">
              <button
                className="cmd-button cancel-button"
                onClick={() => setItemToDelete(null)}
              >
                Cancel
              </button>
              <button
                className="cmd-button delete-confirm-btn"
                onClick={confirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;