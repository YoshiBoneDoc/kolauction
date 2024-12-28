import React from "react";
import { Link } from "react-router-dom";

const HomeButton = () => {
    return (
        <div className="p-4">
            <Link
                to="/"
                className="text-blue-500 underline hover:text-blue-700 text-sm"
            >
                Home
            </Link>
        </div>
    );
};

export default HomeButton;