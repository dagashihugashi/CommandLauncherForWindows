import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

interface AppItem {
  name: string;
  target: string;
}

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AppItem[]>([]); // ★型を AppItem[] に修正
  const [appList, setAppList] = useState<AppItem[]>([]); // ★型を AppItem[] に修正
  const [openWindows, setOpenWindows] = useState<AppItem[]>([]); // ★型を AppItem[] に修正
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // ▼ 追加：上下キーで選択しているアイテムのインデックス
  const [selectedIndex, setSelectedIndex] = useState(0);

  const showError = () => {
    setErrorMsg("Can't open the App!");
    setTimeout(() => setErrorMsg(null), 3000);
  };

  // ▼ useEffectの外に出し、どこからでも呼べるようにした最強の launchApp
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
      console.error("Launch error: ", error);
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
        } catch (e) {}

        let customApps: AppItem[] = [];
        try {
          const jsonString: string = await invoke("load_config");
          const data = JSON.parse(jsonString);
          if (data.custom_apps) customApps = data.custom_apps;
        } catch (e) {}

        let scannedApps: AppItem[] = [];
        try {
          scannedApps = await invoke("scan_apps");
        } catch (e) {}

        setAppList([...windows, ...customApps, ...scannedApps]);
      } catch (error) {
        console.error("Fetch error: ", error);
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
      const filtered = appList.filter(app =>
        app.name.toLowerCase().includes(value.toLowerCase())
      );
      setResults(filtered);
    } else {
      setResults([]);
    }
  };

  // ▼ Enterキーと、上下キーの処理を統合
  const handleExecute = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (results.length > 0) {
        // リストから選択されているものを起動
        await launchApp(results[selectedIndex]);
      } else if (query) {
        // リストにない直接入力のコマンドを起動
        await launchApp({ name: query, target: query });
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

  return (
    <main style={{ padding: "20px", background: "rgba(30, 30, 30, 0.9)", height: "100vh", boxSizing: "border-box" }}>
      <input
        type="text"
        placeholder="Search apps, tabs, or commands..."
        autoFocus
        value={query}
        onChange={handleSearch}
        onKeyDown={handleExecute}
        style={{
          width: "100%",
          padding: "15px 20px",
          fontSize: "24px",
          borderRadius: "10px",
          border: "none",
          outline: "none",
          background: "#2a2a2a",
          color: "#ffffff",
          boxShadow: "0 4px 6px rgba(0,0,0,0.3)"
        }}
      />
      {results.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0 0", background: "#2a2a2a", borderRadius: "10px", overflow: "hidden" }}>
          {results.map((app, index) => (
            <li key={index} 
                onClick={() => launchApp(app)} 
                // ▼ 選択されているアイテムの背景色と文字色をハイライトする
                style={{ 
                  padding: "15px 20px", 
                  color: index === selectedIndex ? "#ffffff" : "#aaaaaa", 
                  background: index === selectedIndex ? "#4a4a4a" : "transparent", 
                  fontSize: "18px",
                  cursor: "pointer"
                }}>
              {app.name}
            </li>
          ))}
        </ul>
      )}
      {errorMsg && (
        <div style={{
          position: "fixed",
          bottom: "20px",
          right: "20px",
          background: "rgba(202, 68, 68, 0.95)",
          color: "white",
          padding: "10px 20px",
          borderRadius: "8px",
          fontSize: "14px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          zIndex: 9999
        }}>
          {errorMsg}
        </div>
      )}
    </main>
  );
}

export default App;