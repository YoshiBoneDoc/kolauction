import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter as Router } from "react-router-dom";
import { AuctionsProvider } from "./context/AuctionsContext";
import App from "./App";
import "./index.css";
import { UserProvider } from "./context/UserContext";

ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        <Router>
            <UserProvider>
                <AuctionsProvider>
                    <App />
                </AuctionsProvider>
            </UserProvider>
        </Router>
    </React.StrictMode>
);