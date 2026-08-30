import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="mb-4 font-display text-5xl">404</h1>
        <p className="mb-6 text-muted-foreground">This thread does not exist.</p>
        <Link to="/" className="text-ember underline-offset-4 hover:underline">
          Back to Gera
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
