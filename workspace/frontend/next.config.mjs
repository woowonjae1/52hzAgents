const isDev = process.env.NODE_ENV === 'development';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDev ? {} : { output: 'export', distDir: 'out' }),
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  devIndicators: false,
};

export default nextConfig;

