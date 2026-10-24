import { Link } from 'react-router-dom';
import BackButton from '../components/BackButton';

export default function NotFound() {
    return <main className="site-page-background flex flex-1 items-center justify-center bg-gray-50 px-6 py-12">
        <div className="max-w-lg space-y-4 text-center">
            <p className="text-sm font-semibold text-gray-500">404</p>
            <h1 className="text-3xl font-bold text-gray-900">Page not found</h1>
            <p className="text-gray-600">This page doesn’t exist or may have moved.</p>
            <div className="flex flex-wrap justify-center gap-6 text-sm">
                <BackButton className="text-blue-700 underline" />
                <Link to="/" className="text-blue-700 underline">Go home</Link>
                <Link to="/auctions" className="text-blue-700 underline">Browse auctions</Link>
            </div>
        </div>
    </main>;
}
