import HighRollersInvitation from './components/HighRollersInvitation';
import { lazy, Suspense, useContext } from "react";
import { AuctionsContext } from "./context/AuctionsContext";
import { Routes, Route, useLocation } from "react-router-dom";
import AuctionNavigation from "./components/AuctionNavigation";
const Raffles = lazy(() => import("./pages/Raffles"));
const Leaderboards = lazy(() => import("./pages/Leaderboards"));
const Home = lazy(() => import("./pages/Home"));
const AllAuctions = lazy(() => import("./pages/AllAuctions"));
const AuctionAnItem = lazy(() => import("./pages/AuctionAnItem"));
const Register = lazy(() => import("./pages/Register"));
const Login = lazy(() => import("./pages/Login"));
const Profile = lazy(() => import("./pages/Profile"));
const AuctionDetails = lazy(() => import("./pages/AuctionDetails"));
const InfoPage = lazy(() => import("./pages/InfoPage.jsx"));
const GiveawayInfo = lazy(() => import("./pages/GiveawayInfo"));
const OfficialApproval = lazy(() => import('./pages/OfficialApproval'));
const DonatePage = lazy(() => import("./pages/DonatePage.jsx"));
const AuthEmailPage = lazy(() => import("./pages/AuthEmailPage"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const ConfirmEmail = lazy(() => import("./pages/ConfirmEmail"));
const WallOfShame = lazy(() => import("./pages/WallOfShame"));
const SellerProfile = lazy(() => import('./pages/SellerProfile'));
const ReportBug = lazy(() => import('./pages/ReportBug'));
const TradeQuery = lazy(() => import('./pages/TradeQuery'));
const ReportTrade = lazy(() => import('./pages/ReportTrade'));
const SubmitAppeal = lazy(() => import('./pages/SubmitAppeal'));
const NotFound = lazy(() => import('./pages/NotFound'));
const BugReportInbox = lazy(() => import('./pages/BugReportInbox'));

import SiteBanner from "./components/SiteBanner";
const UpdateLog = lazy(() => import("./pages/UpdateLog"));
const MeetTheCreator = lazy(() => import("./pages/MeetTheCreator"));
const AdminBanner = lazy(() => import("./pages/AdminBanner"));
const AdminPolls = lazy(() => import("./pages/AdminPolls"));
import SiteActivity from "./components/SiteActivity";

function RouteLoading() {
    return <div role="status" className="p-6 text-center">Loading page…</div>;
}

const App = () => {
    const { pathname } = useLocation();
    const { error, refreshAuctions } = useContext(AuctionsContext) || {};
    if (pathname.replace(/\/+$/, '') === '/official-approval') return <Suspense fallback={<RouteLoading />}><OfficialApproval /></Suspense>;
    const isWallOfShame = pathname.replace(/\/+$/, '') === '/wall-of-shame';
    return (
        <div className={`flex min-h-screen flex-col ${isWallOfShame ? 'shame-background' : 'site-page-background bg-[#F9F9F9]'}`}>
            <div className="px-4 sm:px-6"><AuctionNavigation /></div>
            <SiteBanner />
            <HighRollersInvitation />
            {error && <div role="alert" className="bg-red-50 p-4 text-red-700">
                {error}{" "}<button onClick={refreshAuctions} className="underline">Retry</button>
            </div>}
            <SiteActivity><Suspense fallback={<RouteLoading />}><Routes>
                <Route path="/" element={<Home />} />
                <Route path="/raffles" element={<Raffles />} />
                <Route path="/raffle/:id" element={<Raffles />} />
                <Route path="/leaderboards" element={<Leaderboards />} />
                <Route path="/submit-appeal" element={<SubmitAppeal />} />
                <Route path="/report-a-bug" element={<ReportBug />} />
                <Route path="/support" element={<ReportBug support />} />
                <Route path="/update-log" element={<UpdateLog />} />
                <Route path="/meet-the-creator" element={<MeetTheCreator />} />
                <Route path="/admin/banner" element={<AdminBanner />} />
                <Route path="/admin/polls" element={<AdminPolls />} />
                <Route path="/admin/inbox" element={<BugReportInbox />} />
                <Route path="/admin/bug-reports" element={<BugReportInbox />} />
                <Route path="/donate" element={<DonatePage />} /> {/* Add route */}
                <Route path="/wall-of-shame" element={<WallOfShame />} />
                <Route path="/info" element={<InfoPage />} /> {/* Add this route */}
                <Route path="/giveaways" element={<GiveawayInfo />} />
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

            </Routes></Suspense></SiteActivity>
        </div>
    );
};

export default App;
