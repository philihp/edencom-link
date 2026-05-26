/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/build-calculator/:path*',
        destination: 'https://eve-build-calculator.philihp.com/api/:path*',
      },
    ]
  },
}

export default nextConfig
