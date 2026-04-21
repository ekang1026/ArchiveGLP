/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@archiveglp/schema'],
  env: {
    NEXT_PUBLIC_APP_NAME: 'ArchiveGLP',
  },
};

export default nextConfig;
