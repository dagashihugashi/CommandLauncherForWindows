import React, { useEffect, useState } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

// Dummy list to search 
const DUMMY_APPS = ["VS Code", "Google Chrome", "Settings", "Terminal"];

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    // Get window instance
    const appWindow = getCurrentWindow();

    // 1. Set global shortcut "Alt + Space"
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

    // 2. Set ESC to hide window
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        await appWindow.hide();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    // 3. クリーンアップ処理
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
      const filtered = DUMMY_APPS.filter(app =>
        app.toLocaleLowerCase().includes(value.toLocaleLowerCase())
      );
      setResults(filtered);
    } else {
      setResults([]);
    }
  };

  // Enter => exe & hide window
  const handleExecute = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key == "Enter" && query) {
      // LATER : Call out OS's cmd
      console.log('Executed: &{results.length > 0 ? results[0] : query}');

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
              {app}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default App;