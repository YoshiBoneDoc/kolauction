import RenderBoundary from './components/RenderBoundary';
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter as Router } from "react-router-dom";
import { AuctionsProvider } from "./context/AuctionsContext";
import App from "./App";
import "./index.css";
// Load shared surface styles before the theme overrides and before route paint.
import "./components/giveaway.css";
import "./components/homeRaffle.css";
import "./pages/AuctionBookmarkRibbon.css";
import "./theme.css";
// Raffle surfaces are styled before any lazy route can paint.
import "./components/raffles.css";
import { UserProvider } from "./context/UserContext";

ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        <Router>
            <RenderBoundary><UserProvider>
                <AuctionsProvider>
                    <App />
                </AuctionsProvider>
            </UserProvider></RenderBoundary>
        </Router>
    </React.StrictMode>
);