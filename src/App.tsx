import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

// Def data type of Apps
interface AppItem {
  name: string;
  target: string;
}

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [appList, setAppList] = useState([]);

  useEffect(() => {
    // Get window instance
    const appWindow = getCurrentWindow();

    // 1. Load config.json & Start menu
    const fetchConfig = async () => {
      try {
        let customApps: AppItem[] = [];
        try {
          const jsonString: string = await invoke("load_config");
          const data = JSON.parse(jsonString);
          if (data.custom_apps) {
            setAppList(data.custom_apps);
          }
        } catch (e) {
          console.error("Config load failed or missing:", e);
        }

        let scannedApps: AppItem[] = [];
        try {
          scannedApps = await invoke("scan_apps");
        } catch (e) {
          console.warn("Scan failed", e);
        }

        // Merge
        setAppList([...customApps, ...scannedApps]);
      } catch (error) {
        console.error("Fetch error: ", error);
      }
    };

    fetchConfig();

    // 2. Set global shortcut "Alt + Space"
    const setupShortcut = async () => {
      try {
        await register("Alt+Space", async (event) => {
          if (event.state === "Pressed") {
            const isVisible = await appWindow.isVisible();
            if (isVisible) {
              await appWindow.hide();
            } else {
              await appWindow.show();
              await appWindow.setFocus();
              // Clear previous inputs
              setQuery("");
              setResults([]);
            }
          }
        });
      } catch (error) {
        console.error("Failed to register shortcut:", error);
      }
    };

    setupShortcut();

    // 3. Set ESC to hide window
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        await appWindow.hide();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    // 4. クリーンアップ処理
    // アプリのリロード時などに、イベントやショートカットが二重登録されるのを防ぐ
    return () => {
      unregister("Alt+Space").catch(console.error);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Remake list on every inputs
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    if (value) {
      const filtered = appList.filter(app =>
        app.name.toLowerCase().includes(value.toLowerCase())
      );
      setResults(filtered);
    } else {
      setResults([]);
    }
  };

  // Enter => exe & hide window
  const handleExecute = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key == "Enter" && query) {
      // Set input or top of the list => target
      const target = results.length > 0 ? results[0].target : query;

      try {
        // Call open_target in Rust
        await invoke("open_target", { target: target });
        console.log('Successful: Opened ${target}');
      } catch (error) {
        console.error('ERROR: ', error);
      }

      // Hide & reset Launcher
      const appWindow = getCurrentWindow();
      await appWindow.hide();
      setQuery("");
      setResults([]);
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
      {/* Display list if result exists */}
      {results.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0 0", background: "#2a2a2a", borderRadius: "10px", overflow: "hidden" }}>
          {results.map((app, index) => (
            <li key={index} style={{ padding: "15px 20px", color: index === 0 ? "#ffffff" : "#aaaaaa", background: index === 0 ? "#3a3a3a" : "transparent", fontSize: "18px" }}>
              {app.name}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default App;