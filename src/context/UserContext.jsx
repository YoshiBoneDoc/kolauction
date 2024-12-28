import React, { createContext, useEffect, useState } from "react";
import PropTypes from "prop-types";

export const UserContext = createContext();

export const UserProvider = ({ children }) => {
    const [users, setUsers] = useState(() => {
        const storedUsers = localStorage.getItem("users");
        return storedUsers ? JSON.parse(storedUsers) : [];
    });

    const [currentUser, setCurrentUser] = useState(() => {
        const storedUser = localStorage.getItem("currentUser");
        return storedUser ? JSON.parse(storedUser) : null;
    });

    // Function to register a new user
    const registerUser = (user) => {
        const { khubUsername, password } = user;

        // Validate required fields
        if (!khubUsername || !password) {
            throw new Error("All fields are required.");
        }

        const existingUser = users.find((u) => u.khubUsername === khubUsername);
        if (existingUser) {
            throw new Error("A user with this KHub username already exists.");
        }

        setUsers([...users, user]);
    };

    // Function to log in a user
    const loginUser = (khubUsername, password) => {
        const user = users.find(
            (u) => u.khubUsername === khubUsername && u.password === password
        );

        if (!user) {
            throw new Error("Invalid credentials.");
        }

        setCurrentUser(user);
        localStorage.setItem("currentUser", JSON.stringify(user));
    };

    // Function to log out the current user
    const logoutUser = () => {
        setCurrentUser(null);
        localStorage.removeItem("currentUser");
    };

    // Persist users to localStorage on change
    useEffect(() => {
        localStorage.setItem("users", JSON.stringify(users));
    }, [users]);

    return (
        <UserContext.Provider
            value={{ users, currentUser, registerUser, loginUser, logoutUser }}
        >
            {children}
        </UserContext.Provider>
    );
};

// PropTypes validation for `children`
UserProvider.propTypes = {
    children: PropTypes.node.isRequired,
};