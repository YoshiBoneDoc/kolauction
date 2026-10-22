import { useContext } from "react";
import { AuctionsContext } from "./context/AuctionsContext";
import { Routes, Route, useLocation } from "react-router-dom";
import AuctionNavigation from "./components/AuctionNavigation";
import Home from "./pages/Home";
import AllAuctions from "./pages/AllAuctions";
import AuctionAnItem from "./pages/AuctionAnItem";
import Register from "./pages/Register"; // New page
import Login from "./pages/Login"; // Import Login page
import Profile from "./pages/Profile"; // Import Profile
import AuctionDetails from "./pages/AuctionDetails";
import InfoPage from "./pages/InfoPage.jsx";
import DonatePage from "./pages/DonatePage.jsx";
import AuthEmailPage from "./pages/AuthEmailPage";
import ResetPassword from "./pages/ResetPassword";
import ConfirmEmail from "./pages/ConfirmEmail";
import WallOfShame from "./pages/WallOfShame";
import SellerProfile from './pages/SellerProfile';
import ReportBug from './pages/ReportBug';
import TradeQuery from './pages/TradeQuery';
import ReportTrade from './pages/ReportTrade';
import SubmitAppeal from './pages/SubmitAppeal';
import NotFound from './pages/NotFound';
import BugReportInbox from './pages/BugReportInbox';

const App = () => {
    const { pathname } = useLocation();
    const { error, refreshAuctions } = useContext(AuctionsContext) || {};
    const isWallOfShame = pathname.replace(/\/+$/, '') === '/wall-of-shame';
    return (
        <div className={`flex min-h-screen flex-col ${isWallOfShame ? 'shame-background' : 'bg-[#F9F9F9]'}`}>
            <div className="px-4 sm:px-6"><AuctionNavigation /></div>
            {error && <div role="alert" className="bg-red-50 p-4 text-red-700">
                {error}{" "}<button onClick={refreshAuctions} className="underline">Retry</button>
            </div>}
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/submit-appeal" element={<SubmitAppeal />} />
                <Route path="/report-a-bug" element={<ReportBug />} />
                <Route path="/support" element={<ReportBug support />} />
                <Route path="/admin/inbox" element={<BugReportInbox />} />
                <Route path="/admin/bug-reports" element={<BugReportInbox />} />
                <Route path="/donate" element={<DonatePage />} /> {/* Add route */}
                <Route path="/wall-of-shame" element={<WallOfShame />} />
                <Route path="/info" element={<InfoPage />} /> {/* Add this route */}
                <Route path="/auctions" element={<AllAuctions />} />
                <Route path="/auction-item" element={<AuctionAnItem />} />
                <Route path="/register" element={<Register />} />
                <Route path="/forgot-password" element={<AuthEmailPage key="recovery" mode="recovery" />} />
                <Route path="/resend-confirmation" element={<AuthEmailPage key="confirmation" mode="confirmation" />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/change-password" element={<ResetPassword />} />
                <Route path="/auth/confirm" element={<ConfirmEmail />} />
                <Route path="/login" element={<Login />} /> {/* Add Login route */}
                <Route path="/profile" element={<Profile />} /> {/* Add Profile route */}
                <Route path="/seller/:id" element={<SellerProfile />} />
                <Route path="/auction/:id/trade-query" element={<TradeQuery />} />
                <Route path="/auction/:id/report-trade" element={<ReportTrade />} />
                <Route path="/auction/:id" element={<AuctionDetails />} />
                <Route path="*" element={<NotFound />} />

            </Routes>
        </div>
    );
};

export default App;
