import { useState, useContext } from "react";
import { UserContext } from "../context/UserContext";
import { Link, useNavigate } from "react-router-dom";

const Login = () => {
    const { loginUser } = useContext(UserContext);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (isSubmitting) return;
        setErrorMessage("");
        setIsSubmitting(true);
        try {
            await loginUser(email, password);
            navigate("/");
        } catch (error) {
            setErrorMessage(error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="flex-1 bg-gray-50 flex flex-col items-center justify-center px-4 py-16">

            <form
                onSubmit={handleSubmit}
                className="w-full max-w-md bg-white shadow-md rounded p-6 [color-scheme:light]"
            >
                <h1 className="text-2xl font-bold text-center mb-6">Log In</h1>

                {errorMessage && (
                    <p role="alert" className="text-red-500 text-sm mb-4">{errorMessage}</p>
                )}
                <p className="text-gray-600 text-sm mb-4">Use your kHub username (KH_ followed by your KoL name) and your kHub password.</p>

                <div className="mb-4">
                    <label
                        htmlFor="email"
                        className="block text-gray-700 font-bold mb-2"
                    >
                        kHub Username
                    </label>
                    <input
                        type="text"
                        id="email"
                        autoComplete="username"
                        placeholder="KH_Your KoL name"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full p-2 border border-gray-400 rounded bg-white text-gray-900 placeholder:text-gray-500"
                        required
                    />
                </div>

                <div className="mb-6">
                    <label
                        htmlFor="password"
                        className="block text-gray-700 font-bold mb-2"
                    >
                        Password
                    </label>
                    <input
                        type="password"
                        id="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full p-2 border border-gray-400 rounded bg-white text-gray-900 placeholder:text-gray-500"
                        required
                    />
                </div>

                <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
                >
                    {isSubmitting ? "Logging in…" : "Log In"}
                </button>
                <div className="flex flex-wrap gap-4 mt-4 text-sm text-blue-700 underline">
                    <Link to="/forgot-password">Forgot password?</Link>
                    <Link to="/register">Register</Link>
                </div>
            </form>
        </div>
    );
};

export default Login;
