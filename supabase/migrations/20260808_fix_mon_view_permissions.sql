-- Restrict monitoring view access to service_role only
-- These views are read by the backend monitoring endpoint, not by clients

REVOKE ALL ON public.mon_006 FROM public, anon, authenticated;
REVOKE ALL ON public.mon_011 FROM public, anon, authenticated;
REVOKE ALL ON public.mon_012 FROM public, anon, authenticated;
REVOKE ALL ON public.mon_013 FROM public, anon, authenticated;
REVOKE ALL ON public.mon_014 FROM public, anon, authenticated;
REVOKE ALL ON public.mon_015 FROM public, anon, authenticated;

GRANT SELECT ON public.mon_006 TO service_role;
GRANT SELECT ON public.mon_011 TO service_role;
GRANT SELECT ON public.mon_012 TO service_role;
GRANT SELECT ON public.mon_013 TO service_role;
GRANT SELECT ON public.mon_014 TO service_role;
GRANT SELECT ON public.mon_015 TO service_role;
