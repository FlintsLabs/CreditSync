import jwt from "jsonwebtoken";

const token = jwt.sign(
    {
        id: 1,
        email: "test@example.com",
        role: "owner",
        tenantId: "default_tenant"
    },
    process.env.JWT_SECRET || "default_secret_please_change"
);

console.log(token);
