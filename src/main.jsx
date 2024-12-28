import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter as Router } from "react-router-dom";
import { AuctionsProvider } from "./context/AuctionsContext";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        <AuctionsProvider>
            <Router>
                <App />
            </Router>
        </AuctionsProvider>
    </React.StrictMode>
);