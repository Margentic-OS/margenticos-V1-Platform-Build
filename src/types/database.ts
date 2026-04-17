export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      campaigns: {
        Row: {
          campaign_type: string
          created_at: string
          external_id: string | null
          id: string
          organisation_id: string
          paused_at: string | null
          sequence_name: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          campaign_type: string
          created_at?: string
          external_id?: string | null
          id?: string
          organisation_id: string
          paused_at?: string | null
          sequence_name?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          campaign_type?: string
          created_at?: string
          external_id?: string | null
          id?: string
          organisation_id?: string
          paused_at?: string | null
          sequence_name?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_suggestions: {
        Row: {
          ab_variant: string | null
          confidence_level: string
          conflicting_suggestion_id: string | null
          created_at: string
          current_value: string | null
          document_id: string | null
          document_type: string
          field_path: string
          id: string
          organisation_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          sequence_position: number | null
          signal_count: number
          status: string
          suggested_value: string
          suggestion_reason: string | null
        }
        Insert: {
          ab_variant?: string | null
          confidence_level?: string
          conflicting_suggestion_id?: string | null
          created_at?: string
          current_value?: string | null
          document_id?: string | null
          document_type: string
          field_path: string
          id?: string
          organisation_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sequence_position?: number | null
          signal_count?: number
          status?: string
          suggested_value: string
          suggestion_reason?: string | null
        }
        Update: {
          ab_variant?: string | null
          confidence_level?: string
          conflicting_suggestion_id?: string | null
          created_at?: string
          current_value?: string | null
          document_id?: string | null
          document_type?: string
          field_path?: string
          id?: string
          organisation_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sequence_position?: number | null
          signal_count?: number
          status?: string
          suggested_value?: string
          suggestion_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_suggestions_conflicting_suggestion_id_fkey"
            columns: ["conflicting_suggestion_id"]
            isOneToOne: false
            referencedRelation: "document_suggestions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "strategy_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_suggestions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_responses: {
        Row: {
          field_key: string
          field_label: string
          id: string
          is_critical: boolean
          organisation_id: string
          response_value: string | null
          section: string
          updated_at: string
          version: number
          word_count: number
        }
        Insert: {
          field_key: string
          field_label: string
          id?: string
          is_critical?: boolean
          organisation_id: string
          response_value?: string | null
          section: string
          updated_at?: string
          version?: number
          word_count?: number
        }
        Update: {
          field_key?: string
          field_label?: string
          id?: string
          is_critical?: boolean
          organisation_id?: string
          response_value?: string | null
          section?: string
          updated_at?: string
          version?: number
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "intake_responses_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_responses_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations_registry: {
        Row: {
          api_handler_ref: string
          capability: string
          config: Json
          connection_status: string
          created_at: string
          id: string
          is_active: boolean
          tool_name: string
          updated_at: string
        }
        Insert: {
          api_handler_ref: string
          capability: string
          config?: Json
          connection_status?: string
          created_at?: string
          id?: string
          is_active?: boolean
          tool_name: string
          updated_at?: string
        }
        Update: {
          api_handler_ref?: string
          capability?: string
          config?: Json
          connection_status?: string
          created_at?: string
          id?: string
          is_active?: boolean
          tool_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      meetings: {
        Row: {
          booked_at: string
          campaign_id: string | null
          created_at: string
          id: string
          meeting_date: string | null
          organisation_id: string
          prospect_id: string | null
          qualification: string | null
          qualification_notes: string | null
          revenue_value: number | null
          status: string
          updated_at: string
        }
        Insert: {
          booked_at?: string
          campaign_id?: string | null
          created_at?: string
          id?: string
          meeting_date?: string | null
          organisation_id: string
          prospect_id?: string | null
          qualification?: string | null
          qualification_notes?: string | null
          revenue_value?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          booked_at?: string
          campaign_id?: string | null
          created_at?: string
          id?: string
          meeting_date?: string | null
          organisation_id?: string
          prospect_id?: string | null
          qualification?: string | null
          qualification_notes?: string | null
          revenue_value?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      organisations: {
        Row: {
          contract_start_date: string | null
          contract_status: string | null
          created_at: string
          engagement_month: number
          id: string
          meetings_count: number
          name: string
          payment_status: string | null
          pipeline_unlock_at: string | null
          pipeline_unlock_manual_override: boolean
          pipeline_unlocked: boolean
          slug: string
          updated_at: string
        }
        Insert: {
          contract_start_date?: string | null
          contract_status?: string | null
          created_at?: string
          engagement_month?: number
          id?: string
          meetings_count?: number
          name: string
          payment_status?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlock_manual_override?: boolean
          pipeline_unlocked?: boolean
          slug: string
          updated_at?: string
        }
        Update: {
          contract_start_date?: string | null
          contract_status?: string | null
          created_at?: string
          engagement_month?: number
          id?: string
          meetings_count?: number
          name?: string
          payment_status?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlock_manual_override?: boolean
          pipeline_unlocked?: boolean
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      patterns: {
        Row: {
          confidence_score: number | null
          created_at: string
          id: string
          pattern_data: Json
          pattern_type: string
          sample_size: number
          updated_at: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          pattern_data?: Json
          pattern_type: string
          sample_size?: number
          updated_at?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          pattern_data?: Json
          pattern_type?: string
          sample_size?: number
          updated_at?: string
        }
        Relationships: []
      }
      prospects: {
        Row: {
          company_name: string | null
          created_at: string
          email: string | null
          first_name: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          organisation_id: string
          personalisation_trigger: string | null
          research_source: string | null
          role: string | null
          suppressed: boolean
          suppressed_at: string | null
          suppression_reason: string | null
          updated_at: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          organisation_id: string
          personalisation_trigger?: string | null
          research_source?: string | null
          role?: string | null
          suppressed?: boolean
          suppressed_at?: string | null
          suppression_reason?: string | null
          updated_at?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          organisation_id?: string
          personalisation_trigger?: string | null
          research_source?: string | null
          role?: string | null
          suppressed?: boolean
          suppressed_at?: string | null
          suppression_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prospects_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prospects_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      signals: {
        Row: {
          campaign_id: string | null
          created_at: string
          id: string
          organisation_id: string
          processed: boolean
          processed_at: string | null
          prospect_id: string | null
          raw_data: Json
          signal_type: string
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string
          id?: string
          organisation_id: string
          processed?: boolean
          processed_at?: string | null
          prospect_id?: string | null
          raw_data?: Json
          signal_type: string
        }
        Update: {
          campaign_id?: string | null
          created_at?: string
          id?: string
          organisation_id?: string
          processed?: boolean
          processed_at?: string | null
          prospect_id?: string | null
          raw_data?: Json
          signal_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "signals_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_documents: {
        Row: {
          content: Json
          created_at: string
          document_type: string
          generated_at: string | null
          id: string
          is_stale: boolean
          last_updated_at: string
          organisation_id: string
          plain_text: string | null
          status: string
          update_trigger: string | null
          version: string
        }
        Insert: {
          content?: Json
          created_at?: string
          document_type: string
          generated_at?: string | null
          id?: string
          is_stale?: boolean
          last_updated_at?: string
          organisation_id: string
          plain_text?: string | null
          status?: string
          update_trigger?: string | null
          version?: string
        }
        Update: {
          content?: Json
          created_at?: string
          document_type?: string
          generated_at?: string | null
          id?: string
          is_stale?: boolean
          last_updated_at?: string
          organisation_id?: string
          plain_text?: string | null
          status?: string
          update_trigger?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_documents_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategy_documents_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          last_seen_at: string | null
          organisation_id: string | null
          role: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          last_seen_at?: string | null
          organisation_id?: string | null
          role: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          last_seen_at?: string | null
          organisation_id?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "client_organisation_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_organisation_id_fkey"
            columns: ["organisation_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      client_organisation_view: {
        Row: {
          contract_start_date: string | null
          created_at: string | null
          id: string | null
          meetings_count: number | null
          name: string | null
          pipeline_unlock_at: string | null
          pipeline_unlocked: boolean | null
          slug: string | null
          updated_at: string | null
        }
        Insert: {
          contract_start_date?: string | null
          created_at?: string | null
          id?: string | null
          meetings_count?: number | null
          name?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlocked?: boolean | null
          slug?: string | null
          updated_at?: string | null
        }
        Update: {
          contract_start_date?: string | null
          created_at?: string | null
          id?: string | null
          meetings_count?: number | null
          name?: string | null
          pipeline_unlock_at?: string | null
          pipeline_unlocked?: boolean | null
          slug?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      approve_document_suggestion: {
        Args: { p_reviewer_id: string; p_suggestion_id: string }
        Returns: Json
      }
      get_my_organisation_id: { Args: never; Returns: string }
      is_operator: { Args: never; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
