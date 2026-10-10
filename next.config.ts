import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Silence Mongoose/MongoDB optional peer dep warnings in the build output
  serverExternalPackages: ['mongoose'],
  // Enable React strict mode for better dev experience
  reactStrictMode: true,
};

export default nextConfig;
