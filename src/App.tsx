import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import Fuse from "fuse.js";
import React, { useEffect, useState } from "react";
import "./App.css";

interface AppItem {
  name: string;
  target: string;
  description?: string;
  isCustom?: boolean;
}

const ADD_COMMAND: AppItem = {
  name: "Add command",
  target: "cmd:add",
  description: "Create a new custom command"
};

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AppItem[]>([]);
  const [appList, setAppList] = useState<AppItem[]>([]);
  const [openWindows, setOpenWindows] = useState<AppItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<'search' | 'add-command'>('search');
  const [newApp, setNewApp] = useState({ name: '', target: '', description: '' });
  const errorTimeoutRef = React.useRef<number | null>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingOldName, setEditingOldName] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const successTimeoutRef = React.useRef<number | null>(null);

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

    // 新しいタイマーをセット (window.setTimeout と書くとブラウザの関数だと明示できて安全です)
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

  // Icon
  const getBadge = (target: string) => {
    if (target === "cmd:add") return <span className="badge badge-cmd">CMD</span>;
    if (target.startsWith("http")) return <span className="badge badge-url">URL</span>;
    if (target.startsWith("HWND:")) return <span className="badge badge-win">WIN</span>;
    return <span className="badge badge-app">APP</span>;  // アプリやコマンド
  };

  // Launch
  const launchApp = async (app: AppItem) => {
    let finalTarget = app.target;

    if (finalTarget.startsWith("http")) {
      try {
        const urlObj = new URL(finalTarget);
        const keyword = urlObj.hostname.replace("www.", "").split(".")[0];
        const matchingWindow = openWindows.find(w =>
          w.name.toLowerCase().includes(keyword.toLowerCase())
        );

        if (matchingWindow) {
          finalTarget = matchingWindow.target;
        }
      } catch (e) {
        console.warn("URL parse error:", e);
      }
    }

    try {
      await invoke("open_target", { target: finalTarget });

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

  useEffect(() => {
    const appWindow = getCurrentWindow();

    const fetchConfig = async () => {
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
        } catch (e) {
          console.warn("Failed to load config:", e);
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
    };

    fetchConfig();

    const setupShortcut = async () => {
      try {
        await register("Alt+Space", async (event) => {
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
        });
      } catch (error) {
        console.error("Failed to register shortcut:", error);
      }
    };

    setupShortcut();
    return () => {
      unregister("Alt+Space").catch(console.error);
    }

  }, []);

  // 画面全体でのキーボード操作を監視する
  React.useEffect(() => {
    const appWindow = getCurrentWindow();

    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (mode === 'add-command') {
          // Add Command画面にいる時は、検索画面に戻るだけ（アプリは閉じない）
          e.preventDefault();
          e.stopPropagation();
          setMode('search');
          setNewApp({ name: '', target: '', description: '' });
        } else {
          // mode が 'search' の場合は何もしない（＝そのまま上位に伝わってアプリが閉じる）
          await appWindow.hide();
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [mode]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
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

  // ▼ Enterキーと、上下キーの処理を統合
  const handleExecute = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const selectedItem = results[selectedIndex] || { name: query, target: query };
      if (selectedItem.target === "cmd:add") {
        setMode('add-command');
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
    }
  };


  const handleSaveCommand = async () => {
    if (!newApp.name || !newApp.target) {
      showError("Name and Target are required");
      return;
    }

    try {
      if (editingOldName) {
        // ▼ 編集モードの場合（Rustの edit_command を呼ぶ）
        // ※ TauriはJavaScriptのキャメルケースを自動でRustのスネークケースに変換してくれます
        await invoke("edit_command", {
          oldName: editingOldName,
          newName: newApp.name,
          newTarget: newApp.target,
          newDescription: newApp.description || null
        });

        // リストの該当箇所だけを新しいデータに置き換える
        setAppList(prev => prev.map(item =>
          item.name === editingOldName ? { ...newApp, isCustom: true } : item
        ));
      } else {
        // ▼ 新規追加モードの場合（元の処理）
        await invoke("save_command", {
          name: newApp.name,
          target: newApp.target,
          description: newApp.description || null
        });
        setAppList(prev => [...prev, { ...newApp, isCustom: true }]);
      }

      showSuccess(editingOldName ? "Command edited!" : "Command added!");

      // ▼ 共通の入力リセット処理
      setMode('search');
      setNewApp({ name: '', target: '', description: '' });
      setEditingOldName(null); // 記憶をリセット
    } catch (e) {
      showError(editingOldName ? "Failed to edit command" : "Failed to save command");
    }
  };

  const handleAddCommandKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveCommand();
    }
  };

  const handleDelete = async (e: React.MouseEvent, appToDelete: AppItem) => {
    e.stopPropagation(); // 親要素のクリックイベント（アプリ起動）を防ぐ

    if (!window.confirm(`「${appToDelete.name}」を削除してもよろしいですか？`)) return;

    try {
      // 1. Rustに削除を依頼
      await invoke("delete_command", { name: appToDelete.name });

      // 2. Reactの画面上から即座に消す（appListとresultsの両方からフィルタリング）
      setAppList(prev => prev.filter(item => item.name !== appToDelete.name));
      setResults(prev => prev.filter(item => item.name !== appToDelete.name));

      // 3. 選択位置のズレを防ぐ
      setSelectedIndex(0);

      showSuccess("Command deleted!");
    } catch (error) {
      console.error("削除エラー:", error);
      showError("Failed to delete command");
    }
  };

  const handleEdit = (e: React.MouseEvent, appToEdit: AppItem) => {
    e.stopPropagation(); // アプリ起動を止める

    // 既存のデータを入力欄（newApp）にセットする
    setNewApp({
      name: appToEdit.name,
      target: appToEdit.target,
      description: appToEdit.description || ''
    });

    setEditingOldName(appToEdit.name); // 変更前の名前を記憶
    setMode('add-command'); // 画面を入力モードに切り替え
  };


  return (
    <main className="main-container">
      <div className="launcher-wrapper">
        {mode === 'search' ? (
          <>
            <input
              className="search-input"
              type="text"
              placeholder="Where do you wanna go?"
              autoFocus
              value={query}
              onChange={handleSearch}
              onKeyDown={handleExecute}
            />

            {results.length > 0 && (
              <ul className="suggest-list" ref={listRef}>
                {results.slice(0, 20).map((app, index) => (
                  <li key={index}
                    onClick={() => launchApp(app)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`suggest-item ${index === selectedIndex ? 'selected' : 'unselected'}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {getBadge(app.target)}
                      <span>{app.name.replace("🪟 ", "")}</span>
                    </div>
                    {app.isCustom && (
                      <div className="action-buttons">
                        <button
                          onClick={(e) => handleEdit(e, app)}
                          className="action-btn"
                          title="Edit command"
                        >
                          edit
                        </button>

                        <button
                          onClick={(e) => handleDelete(e, app)}
                          className="action-btn"
                          title="Delete command"
                        >
                          delete
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="add-command-container">
            <h2>{editingOldName ? "Edit Command" : "Add New Command"}</h2>

            <div className="input-group">
              <label>Name</label>
              <input
                className="add-command-input"
                placeholder="e.g., My App"
                value={newApp.name}
                onChange={e => setNewApp({ ...newApp, name: e.target.value })}
                onKeyDown={handleAddCommandKeyDown}
                autoFocus
              />
            </div>

            <div className="input-group">
              <label>Target (URL or Path)</label>
              <input
                className="add-command-input"
                placeholder="e.g., https://... or C:\..."
                value={newApp.target}
                onChange={e => setNewApp({ ...newApp, target: e.target.value })}
                onKeyDown={handleAddCommandKeyDown}
              />
            </div>

            <div className="input-group">
              <label>Description (Optional)</label>
              <input
                className="add-command-input"
                placeholder="What does this do?"
                value={newApp.description}
                onChange={e => setNewApp({ ...newApp, description: e.target.value })}
                onKeyDown={handleAddCommandKeyDown}
              />
            </div>

            <div className="button-group">
              <button
                className="cmd-button cancel-button"
                onClick={() => {
                  setMode('search');
                  setNewApp({ name: '', target: '', description: '' });
                  setEditingOldName(null);
                }}
              >
                Cancel
              </button>

              <button
                className="cmd-button save-button"
                onClick={handleSaveCommand}
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
      {errorMsg && <div className="error-popup">✖  {errorMsg}</div>}
      {successMsg && <div className="success-popup">✔  {successMsg}</div>}
    </main>
  );
}

export default App;