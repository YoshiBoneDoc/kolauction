import React, { useState, useContext } from "react";
import { UserContext } from "../context/UserContext";
import { Link, useNavigate } from "react-router-dom";

const Register = () => {
    const { registerUser } = useContext(UserContext);
    const [khubUsername, setKhubUsername] = useState("");
    const [password, setPassword] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const navigate = useNavigate(); // React Router navigation hook

    const handleSubmit = (e) => {
        e.preventDefault();

        try {
            registerUser({ khubUsername, password });
            setErrorMessage(""); // Clear any previous error messages
            navigate("/login"); // Redirect to login page
        } catch (error) {
            setErrorMessage(error.message);
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
                    <p className="text-red-500 text-sm mb-4">{errorMessage}</p>
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
                        value={khubUsername}
                        onChange={(e) => setKhubUsername(e.target.value)}
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
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full p-2 border rounded"
                        required
                    />
                </div>

                <button
                    type="submit"
                    className="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
                >
                    Register
                </button>
            </form>
        </div>
    );
};

export default Register;