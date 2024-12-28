import React from "react";
import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import AllAuctions from "./pages/AllAuctions";
import AuctionAnItem from "./pages/AuctionAnItem";
import Register from "./pages/Register"; // New page
import Login from "./pages/Login"; // Import Login page

const App = () => {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/auctions" element={<AllAuctions />} />
            <Route path="/auction-item" element={<AuctionAnItem />} />
            <Route path="/register" element={<Register />} />
            <Route path="/login" element={<Login />} /> {/* Add Login route */}
        </Routes>
    );
};

export default App;