import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import Fuse from "fuse.js";
import { show } from "@tauri-apps/api/app";

interface AppItem {
  name: string;
  target: string;
  description?: string;
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

  const listRef = React.useRef<HTMLUListElement>(null);

  // 上下キーで選択しているアイテムのインデックス
  const [selectedIndex, setSelectedIndex] = useState(0);

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

  const showError = () => {
    setErrorMsg("Invalid command!");
    setTimeout(() => setErrorMsg(null), 3000);
  };

  const showSaveError = () => {
    setErrorMsg("Failed to save command!");
    setTimeout(() => setErrorMsg(null), 3000);
  };

  // Icon
  const getIcon = (target: string) => {
    if (target.startsWith("http")) return "🌐";   // Webサイト
    if (target.startsWith("HWND:")) return "🪟";  // 開いているウィンドウ
    return "🚀";                                // アプリやコマンド
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
        //console.warn("URL parse error:", e);
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
      //console.error("Launch error: ", error);
      showError(); // 失敗した時はウィンドウを隠さず、エラーを出す！
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
        } catch (e) { }

        let customApps: AppItem[] = [];
        try {
          const jsonString: string = await invoke("load_config");
          const data = JSON.parse(jsonString);
          if (data.custom_apps) customApps = data.custom_apps;
        } catch (e) { }

        let scannedApps: AppItem[] = [];
        try {
          scannedApps = await invoke("scan_apps");
        } catch (e) { }

        setAppList([...windows, ...customApps, ...scannedApps]);
      } catch (error) {
        //console.error("Fetch error: ", error);
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
        //console.error("Failed to register shortcut:", error);
      }
    };

    setupShortcut();

    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") await appWindow.hide();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      unregister("Alt+Space").catch(console.error);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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
        showError();
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

  // 保存処理を一つの関数にまとめる
  const handleSaveCommand = async () => {
    // 空欄なら保存しない（簡易バリデーション）
    if (!newApp.name || !newApp.target) return;

    try {
      await invoke("save_command", { 
        name: newApp.name, 
        target: newApp.target, 
        description: newApp.description || null 
      });
      setAppList(prev => [...prev, newApp]);
      setMode('search'); 
      setNewApp({ name: '', target: '', description: '' }); 
    } catch (e) {
      showSaveError();
    }
  };

  // Add Command 画面用のキーボード操作ハンドラ
  const handleAddCommandKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveCommand();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMode('search');
      setNewApp({ name: '', target: '', description: '' });
    }
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
                    className={`suggest-item ${index === selectedIndex ? 'selected' : 'unselected'}`}
                  >
                    <span style={{ fontSize: "20px" }}>{getIcon(app.target)}</span>
                    <span>{app.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="add-command-container">
            <h2>Add New Command</h2>
            
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
      {errorMsg && <div className="error-popup">{errorMsg}</div>}
    </main>
  );
}

export default App;