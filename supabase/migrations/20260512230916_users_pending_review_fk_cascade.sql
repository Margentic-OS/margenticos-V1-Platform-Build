-- Fix FK on users_pending_review.attempted_org_id to CASCADE on org delete.
-- Without CASCADE, deleting an org with a pending review row fails with a
-- foreign key violation. Deleting an org should clean up all associated rows.

ALTER TABLE public.users_pending_review
  DROP CONSTRAINT users_pending_review_attempted_org_id_fkey,
  ADD CONSTRAINT users_pending_review_attempted_org_id_fkey
    FOREIGN KEY (attempted_org_id)
    REFERENCES public.organisations(id)
    ON DELETE CASCADE;
