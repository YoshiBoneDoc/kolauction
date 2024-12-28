import React from "react";
import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import AllAuctions from "./pages/AllAuctions";
import AuctionAnItem from "./pages/AuctionAnItem";

const App = () => {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/auctions" element={<AllAuctions />} />
            <Route path="/auction-item" element={<AuctionAnItem />} />
        </Routes>
    );
};

export default App;