import { useState, useContext } from "react";
import { UserContext } from "../context/UserContext";
import { Link, useNavigate } from "react-router-dom";

const Register = () => {
    const { registerUser } = useContext(UserContext);
    const [khubUsername, setKhubUsername] = useState("");
    const [email, setEmail] = useState(""); // Email field
    const [password, setPassword] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [successMessage, setSuccessMessage] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const navigate = useNavigate(); // React Router navigation hook

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (isSubmitting) return;
        setErrorMessage("");
        setSuccessMessage("");

        // Client-side validation for inputs
        if (!khubUsername.trim() || !email.trim() || !password) {
            setErrorMessage("All fields are required.");
            return;
        }
        if (khubUsername.trim().length > 16) {
            setErrorMessage("Username cannot exceed 16 characters.");
            return;
        }
        if (password.length < 6) {
            setErrorMessage("Password must contain at least 6 characters.");
            return;
        }
        if (!/\S+@\S+\.\S+/.test(email)) {
            setErrorMessage("Please enter a valid email address.");
            return;
        }

        setIsSubmitting(true);
        try {
            const data = await registerUser({ khubUsername, email, password });
            setPassword("");
            if (data.session) {
                navigate("/");
            } else {
                setSuccessMessage("Account created. Check your email for a confirmation link before logging in.");
            }
        } catch (error) {
            setErrorMessage(error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
            <Link
                to="/"
                className="absolute top-4 left-4 text-blue-500 hover:underline"
            >
                Home
            </Link>

            <form
                onSubmit={handleSubmit}
                className="w-full max-w-md bg-white shadow-md rounded p-6"
            >
                <h1 className="text-2xl font-bold text-center mb-6">Register</h1>

                {errorMessage && (
                    <p role="alert" className="text-red-500 text-sm mb-4">{errorMessage}</p>
                )}

                {successMessage && (
                    <p role="status" className="text-green-700 text-sm mb-4">
                        {successMessage} <Link to="/login" className="underline">Log in</Link>
                    </p>
                )}

                <div className="mb-4">
                    <label
                        htmlFor="khubUsername"
                        className="block text-gray-700 font-bold mb-2"
                    >
                        KHub Username
                    </label>
                    <input
                        type="text"
                        id="khubUsername"
                        maxLength={16}
                        autoComplete="username"
                        value={khubUsername}
                        onChange={(e) => setKhubUsername(e.target.value)}
                        className="w-full p-2 border rounded"
                        required
                    />
                </div>

                <div className="mb-4">
                    <label
                        htmlFor="email"
                        className="block text-gray-700 font-bold mb-2"
                    >
                        Email
                    </label>
                    <input
                        type="email"
                        id="email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full p-2 border rounded"
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
                        minLength={6}
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full p-2 border rounded"
                        required
                    />
                </div>

                <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
                >
                    {isSubmitting ? "Creating account…" : "Register"}
                </button>
                <p className="text-sm mt-4">
                    Already registered or waiting for an email?{' '}
                    <Link to="/login" className="text-blue-700 underline">Log in</Link>{' · '}
                    <Link to="/resend-confirmation" className="text-blue-700 underline">Resend confirmation</Link>
                </p>
            </form>
        </div>
    );
};

export default Register;